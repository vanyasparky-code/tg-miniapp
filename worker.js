const { createClient } = require("@supabase/supabase-js");
const { execFile } = require("child_process");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const ffmpegPath = require("ffmpeg-static");
const sharp = require("sharp");

async function setupHiggsfieldCredentials() {
  if (!process.env.HIGGSFIELD_CREDENTIALS_B64) {
    console.log("No HIGGSFIELD_CREDENTIALS_B64 found");
    return;
  }

  const configDir = path.join(os.homedir(), ".config", "higgsfield");
  const credentialsPath = path.join(configDir, "credentials.json");

  await fs.mkdir(configDir, { recursive: true });

  const credentialsJson = Buffer.from(
    process.env.HIGGSFIELD_CREDENTIALS_B64,
    "base64"
  ).toString("utf8");

  await fs.writeFile(credentialsPath, credentialsJson);

  const exists = await fs.stat(credentialsPath);
  console.log("Higgsfield credentials path:", credentialsPath);
  console.log("Higgsfield credentials size:", exists.size);
  console.log("Higgsfield credentials file created");
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CHECK_INTERVAL_MS = 15000;

function runHiggsfield(args) {
  return new Promise((resolve, reject) => {
    execFile(
      "npm",
      ["exec", "-y", "--package=@higgsfield/cli", "--", "higgsfield", ...args],
      {
        env: {
          ...process.env,
          HIGGSFIELD_TOKEN: process.env.HIGGSFIELD_TOKEN,
          HIGGSFIELD_CLI_CACHE: "/tmp/higgsfield-cache",
        },
        maxBuffer: 1024 * 1024 * 50,
      },
      (error, stdout, stderr) => {
        if (error) {
          console.error("Higgsfield error:", stderr || error.message);
          reject(new Error(stderr || error.message));
          return;
        }

        try {
          resolve(JSON.parse(stdout));
        } catch (parseError) {
          console.log("Raw Higgsfield output:", stdout);
          reject(parseError);
        }
      }
    );
  });
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
      if (error) {
        console.error("Command error:", stderr || error.message);
        reject(new Error(stderr || error.message));
        return;
      }

      resolve(stdout);
    });
  });
}

async function downloadFile(url, filename) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const filePath = path.join(os.tmpdir(), filename);

  await fs.writeFile(filePath, buffer);

  return filePath;
}

async function uploadToHiggsfield(filePath) {
  const result = await runHiggsfield([
    "upload",
    "create",
    filePath,
    "--json",
  ]);

  if (!result.id) {
    throw new Error("Higgsfield upload did not return id");
  }

  return result;
}

async function uploadPreviewToSupabase(previewPath, orderId) {
  const previewBuffer = await fs.readFile(previewPath);
  const storagePath = `previews/${orderId}.jpg`;

  const { error: uploadError } = await supabase.storage
    .from("media")
    .upload(storagePath, previewBuffer, {
      contentType: "image/jpeg",
      upsert: true,
    });

  if (uploadError) {
    throw new Error(`Preview upload failed: ${uploadError.message}`);
  }

  return supabase.storage.from("media").getPublicUrl(storagePath).data.publicUrl;
}

async function createBlurredPreview(videoUrl, orderId) {
  console.log("Creating blurred preview for order:", orderId);

  const videoPath = await downloadFile(videoUrl, `video-${orderId}.mp4`);
  const framePath = path.join(os.tmpdir(), `frame-${orderId}.jpg`);
  const previewPath = path.join(os.tmpdir(), `preview-${orderId}.jpg`);

  await runCommand(ffmpegPath, [
    "-y",
    "-i",
    videoPath,
    "-ss",
    "00:00:01",
    "-vframes",
    "1",
    framePath,
  ]);

  await sharp(framePath)
    .resize({ width: 720 })
    .blur(18)
    .jpeg({ quality: 80 })
    .toFile(previewPath);

  const previewUrl = await uploadPreviewToSupabase(previewPath, orderId);

  console.log("Preview ready:", previewUrl);

  return previewUrl;
}
async function sendTelegramPreview(order, previewImageUrl, template) {
  if (!process.env.BOT_TOKEN) {
    console.log("No BOT_TOKEN found, skipping Telegram message");
    return;
  }

  if (!order.telegram_user_id) {
    console.log("No telegram_user_id for order:", order.id);
    return;
  }

  const caption =
    `🎬 Ваше видео готово!\n\n` +
    `Это заблюренное превью. Полное видео будет доступно после оплаты.\n\n` +
    `Стоимость: ${template.price_rub || 299} ₽`;

  const response = await fetch(
    `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendPhoto`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: order.telegram_user_id,
        photo: previewImageUrl,
        caption,
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: `Оплатить ${template.price_rub || 299} ₽ и скачать`,
                callback_data: `pay:${order.id}`,
              },
            ],
          ],
        },
      }),
    }
  );

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(`Telegram sendPhoto failed: ${JSON.stringify(data)}`);
  }

  console.log("Telegram preview sent:", order.id);
}
async function createNanoBananaJob(uploadId, photoPrompt, aspectRatio) {
  const result = await runHiggsfield([
    "generate",
    "create",
    "nano_banana_2",
    "--prompt",
    photoPrompt,
    "--input_images",
    JSON.stringify([
      {
        id: uploadId,
        type: "media_input",
      },
    ]),
    "--aspect_ratio",
    aspectRatio || "9:16",
    "--resolution",
    "2k",
    "--json",
  ]);

  return Array.isArray(result) ? result[0] : result.id;
}

async function createSeedanceJob(uploadId, template) {
  const result = await runHiggsfield([
    "generate",
    "create",
    "seedance_2_0",
    "--prompt",
    template.video_prompt,
    "--image",
    uploadId,
    "--aspect_ratio",
    template.aspect_ratio || "9:16",
    "--duration",
    String(template.duration || 5),
    "--resolution",
    template.resolution || "720p",
    "--mode",
    template.mode || "fast",
    "--genre",
    template.genre || "auto",
    "--json",
  ]);

  return Array.isArray(result) ? result[0] : result.id;
}

async function waitForJob(jobId) {
  console.log("Waiting for job:", jobId);

  const result = await runHiggsfield([
    "generate",
    "wait",
    jobId,
    "--timeout",
    "30m",
    "--interval",
    "10s",
    "--quiet",
    "--json",
  ]);

  const job = Array.isArray(result) ? result[0] : result;

  console.log("Wait result:", job);

  if (!job) {
    throw new Error(`No job result returned: ${jobId}`);
  }

  if (job.status === "failed" || job.status === "error") {
    throw new Error(`Higgsfield job failed: ${jobId}`);
  }

  if (!job.result_url) {
    throw new Error(`Job finished but result_url is missing: ${jobId}`);
  }

  return job.result_url;
}

async function processOrder(order) {
  console.log("Processing order:", order.id);

  await supabase
    .from("orders")
    .update({
      status: "processing",
      updated_at: new Date().toISOString(),
    })
    .eq("id", order.id);

  const { data: template, error: templateError } = await supabase
    .from("templates")
    .select("*")
    .eq("slug", order.template_slug)
    .single();

  if (templateError || !template) {
    throw new Error(`Template not found: ${order.template_slug}`);
  }

  const originalFilePath = await downloadFile(
    order.original_photo_url,
    `original-${order.id}.jpg`
  );

  const originalUpload = await uploadToHiggsfield(originalFilePath);
  console.log("Original uploaded:", originalUpload.id);

  const nanoJobId = await createNanoBananaJob(
    originalUpload.id,
    template.photo_prompt,
    template.aspect_ratio
  );

  console.log("Nano Banana job:", nanoJobId);

  const enhancedPhotoUrl = await waitForJob(nanoJobId);
  console.log("Enhanced photo:", enhancedPhotoUrl);

  await supabase
    .from("orders")
    .update({
      enhanced_photo_url: enhancedPhotoUrl,
      status: "photo_ready",
      updated_at: new Date().toISOString(),
    })
    .eq("id", order.id);

  const enhancedFilePath = await downloadFile(
    enhancedPhotoUrl,
    `enhanced-${order.id}.png`
  );

  const enhancedUpload = await uploadToHiggsfield(enhancedFilePath);
  console.log("Enhanced uploaded:", enhancedUpload.id);

  const seedanceJobId = await createSeedanceJob(enhancedUpload.id, template);
  console.log("Seedance job:", seedanceJobId);

const videoUrl = await waitForJob(seedanceJobId);
console.log("Video ready:", videoUrl);

const previewImageUrl = await createBlurredPreview(videoUrl, order.id);

await supabase
  .from("orders")
  .update({
    video_url: videoUrl,
    preview_image_url: previewImageUrl,
    status: "video_ready_locked",
    updated_at: new Date().toISOString(),
  })
  .eq("id", order.id);

console.log("About to send Telegram preview:", {
  orderId: order.id,
  telegramUserId: order.telegram_user_id,
  hasBotToken: Boolean(process.env.BOT_TOKEN),
  previewImageUrl,
});

await sendTelegramPreview(order, previewImageUrl, template);

await supabase
  .from("orders")
  .update({
    bot_message_sent: true,
    bot_message_sent_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })
  .eq("id", order.id);

console.log("Order completed:", order.id);

async function checkOrders() {
  console.log("Checking orders...");

  const { data: orders, error } = await supabase
    .from("orders")
    .select("*")
    .eq("status", "photo_uploaded")
    .limit(1);

  if (error) {
    console.error("Supabase error:", error);
    return;
  }

  if (!orders || orders.length === 0) {
    console.log("No new orders");
    return;
  }

  for (const order of orders) {
    try {
      await processOrder(order);
    } catch (error) {
      console.error("Order failed:", order.id, error.message);

      await supabase
        .from("orders")
        .update({
          status: "failed",
          error_message: error.message,
          updated_at: new Date().toISOString(),
        })
        .eq("id", order.id);
    }
  }
}

async function startWorker() {
  await setupHiggsfieldCredentials();

  console.log("Higgsfield worker started");

  setInterval(checkOrders, CHECK_INTERVAL_MS);
  checkOrders();
}

startWorker();