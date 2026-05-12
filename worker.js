const { createClient } = require("@supabase/supabase-js");
const { execFile } = require("child_process");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const ffmpegPath = require("ffmpeg-static");
const sharp = require("sharp");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CHECK_INTERVAL_MS = 15000;
const VIDEO_GENERATION_MAX_ATTEMPTS = 3;
let telegramUpdateOffset = 0;

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
    execFile(
      command,
      args,
      { maxBuffer: 1024 * 1024 * 50 },
      (error, stdout, stderr) => {
        if (error) {
          console.error("Command error:", stderr || error.message);
          reject(new Error(stderr || error.message));
          return;
        }

        resolve(stdout);
      }
    );
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
    return false;
  }

  if (!order.telegram_user_id) {
    console.log("No telegram_user_id for order:", order.id);
    return false;
  }

  const caption =
    `🎬 Ваше видео готово!\n\n` +
    `Это заблюренное превью. Полное видео будет доступно после оплаты.\n\n` +
    `Стоимость: 1 ⭐`;

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
                text: `Оплатить 1 ⭐ и скачать`,
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
  return true;
}
async function telegramApi(method, payload) {
  if (!process.env.BOT_TOKEN) {
    console.log("No BOT_TOKEN found");
    return null;
  }

  const response = await fetch(
    `https://api.telegram.org/bot${process.env.BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(`Telegram API ${method} failed: ${JSON.stringify(data)}`);
  }

  return data.result;
}

async function answerCallbackQuery(callbackQueryId, text) {
  await telegramApi("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: true,
  });
}

async function sendTelegramMessage(chatId, text) {
  await telegramApi("sendMessage", {
    chat_id: chatId,
    text,
  });
}
async function sendStarsInvoice(chatId, order) {
  const priceStars = 1;

  await telegramApi("sendInvoice", {
    chat_id: chatId,
    title: "Полное видео",
    description: "Оплата доступа к готовому видео без блюра.",
    payload: `order:${order.id}`,
    provider_token: "",
    currency: "XTR",
    prices: [
      {
        label: "Полное видео",
        amount: priceStars,
      },
    ],
  });

  console.log("Stars invoice sent:", order.id);
}

async function sendTelegramVideo(chatId, videoUrl) {
  await telegramApi("sendVideo", {
    chat_id: chatId,
    video: videoUrl,
    caption: "🎬 Ваше полное видео готово!",
    supports_streaming: true,
  });

  console.log("Full video sent:", chatId);
}
async function handlePayCallback(callbackQuery) {
  const callbackData = callbackQuery.data || "";

  if (!callbackData.startsWith("pay:")) {
    return;
  }

  const orderId = callbackData.replace("pay:", "");
  const chatId = callbackQuery.message?.chat?.id;

  console.log("Payment button clicked:", {
    orderId,
    chatId,
    fromUserId: callbackQuery.from?.id,
  });

  const { data: order, error } = await supabase
    .from("orders")
    .select("id, status, paid, video_url, telegram_user_id, price_rub")
    .eq("id", orderId)
    .single();

  if (error || !order) {
    await answerCallbackQuery(
      callbackQuery.id,
      "Заказ не найден. Попробуйте создать видео заново."
    );
    return;
  }

  if (String(order.telegram_user_id) !== String(callbackQuery.from?.id)) {
    await answerCallbackQuery(
      callbackQuery.id,
      "Этот заказ принадлежит другому пользователю."
    );
    return;
  }

  if (order.paid) {
    await answerCallbackQuery(callbackQuery.id, "Видео уже оплачено.");
    await sendTelegramVideo(chatId, order.video_url);
    return;
  }

  if (order.status !== "video_ready_locked" || !order.video_url) {
    await answerCallbackQuery(
      callbackQuery.id,
      "Видео ещё не готово. Подождите немного."
    );
    return;
  }

  await answerCallbackQuery(callbackQuery.id, "Открываю оплату...");

  await sendStarsInvoice(chatId, order);
}
async function handlePreCheckoutQuery(preCheckoutQuery) {
  const payload = preCheckoutQuery.invoice_payload || "";

  if (!payload.startsWith("order:")) {
    await telegramApi("answerPreCheckoutQuery", {
      pre_checkout_query_id: preCheckoutQuery.id,
      ok: false,
      error_message: "Некорректный заказ.",
    });
    return;
  }

  const orderId = payload.replace("order:", "");

  const { data: order, error } = await supabase
    .from("orders")
    .select("id, status, paid, telegram_user_id")
    .eq("id", orderId)
    .single();

  if (error || !order) {
    await telegramApi("answerPreCheckoutQuery", {
      pre_checkout_query_id: preCheckoutQuery.id,
      ok: false,
      error_message: "Заказ не найден.",
    });
    return;
  }

  if (String(order.telegram_user_id) !== String(preCheckoutQuery.from?.id)) {
    await telegramApi("answerPreCheckoutQuery", {
      pre_checkout_query_id: preCheckoutQuery.id,
      ok: false,
      error_message: "Этот заказ принадлежит другому пользователю.",
    });
    return;
  }

  if (order.status !== "video_ready_locked") {
    await telegramApi("answerPreCheckoutQuery", {
      pre_checkout_query_id: preCheckoutQuery.id,
      ok: false,
      error_message: "Видео ещё не готово.",
    });
    return;
  }

  await telegramApi("answerPreCheckoutQuery", {
    pre_checkout_query_id: preCheckoutQuery.id,
    ok: true,
  });

  console.log("Pre-checkout approved:", orderId);
}

async function handleSuccessfulPayment(message) {
  const payment = message.successful_payment;
  const payload = payment?.invoice_payload || "";

  if (!payload.startsWith("order:")) {
    return;
  }

  const orderId = payload.replace("order:", "");
  const chatId = message.chat.id;

  console.log("Successful payment:", {
    orderId,
    chatId,
    chargeId: payment.telegram_payment_charge_id,
    totalAmount: payment.total_amount,
    currency: payment.currency,
  });

  const { data: order, error } = await supabase
    .from("orders")
    .select("id, video_url, telegram_user_id")
    .eq("id", orderId)
    .single();

  if (error || !order || !order.video_url) {
    await sendTelegramMessage(
      chatId,
      "Оплата прошла, но видео не найдено. Напишите в поддержку."
    );
    return;
  }

  await supabase
    .from("orders")
    .update({
      paid: true,
      paid_at: new Date().toISOString(),
      telegram_payment_charge_id: payment.telegram_payment_charge_id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orderId);

  await sendTelegramVideo(chatId, order.video_url);
}
async function handleStartMessage(message) {
  const text = message.text || "";

  if (!text.startsWith("/start")) {
    return;
  }

  const parts = text.split(" ");
  const templateSlug = parts[1] || "repeat_001";

  const chatId = message.chat.id;

  console.log("Start command received:", {
    chatId,
    templateSlug,
  });

  await telegramApi("sendMessage", {
    chat_id: chatId,
    text:
      "🎬 Создай своё видео\n\n" +
      "Нажми кнопку ниже, загрузи фото — и бот сделает видео в этом стиле.",
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "Открыть Mini App",
            web_app: {
              url: `https://tg-miniapp-liart.vercel.app?template=${encodeURIComponent(
                templateSlug
              )}`,
            },
          },
        ],
      ],
    },
  });
}
async function checkTelegramUpdates() {
  if (!process.env.BOT_TOKEN) {
    return;
  }

  try {
    const updates = await telegramApi("getUpdates", {
      offset: telegramUpdateOffset,
      timeout: 0,
      allowed_updates: ["callback_query", "pre_checkout_query", "message"],
    });

    if (!updates || updates.length === 0) {
      return;
    }

    for (const update of updates) {
      telegramUpdateOffset = update.update_id + 1;

      if (update.callback_query) {
    await handlePayCallback(update.callback_query);
  }

  if (update.pre_checkout_query) {
    await handlePreCheckoutQuery(update.pre_checkout_query);
  }

  if (update.message?.successful_payment) {
    await handleSuccessfulPayment(update.message);
      }
  if (update.message?.text) {
    await handleStartMessage(update.message);
      }
    }
  } catch (error) {
    console.error("Telegram updates error:", error.message);
  }
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
  const medias = [
    {
      data: {
        id: uploadId,
        type: "media_input",
      },
      role: "reference",
    },
  ];

  const result = await runHiggsfield([
    "generate",
    "create",
    "seedance_2_0",
    "--prompt",
    template.video_prompt,
    "--medias",
    JSON.stringify(medias),
    "--aspect_ratio",
    template.aspect_ratio || "16:9",
    "--duration",
    String(template.duration || 5),
    "--resolution",
    template.resolution || "720p",
    "--mode",
    template.mode || "std",
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

async function generateVideoWithRetries(uploadId, template) {
  let lastError = null;

  for (let attempt = 1; attempt <= VIDEO_GENERATION_MAX_ATTEMPTS; attempt++) {
    try {
      console.log(
        `Seedance attempt ${attempt}/${VIDEO_GENERATION_MAX_ATTEMPTS}`
      );

      const seedanceJobId = await createSeedanceJob(uploadId, template);
      console.log("Seedance job:", seedanceJobId);

      const videoUrl = await waitForJob(seedanceJobId);
      console.log("Seedance video ready:", videoUrl);

      return videoUrl;
    } catch (error) {
      lastError = error;

      console.error(`Seedance attempt ${attempt} failed:`, error.message);

      if (attempt < VIDEO_GENERATION_MAX_ATTEMPTS) {
        console.log("Retrying Seedance in 15 seconds...");
        await new Promise((resolve) => setTimeout(resolve, 15000));
      }
    }
  }

  throw new Error(
    `Seedance failed after ${VIDEO_GENERATION_MAX_ATTEMPTS} attempts: ${lastError?.message}`
  );
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

  const videoUrl = await generateVideoWithRetries(enhancedUpload.id, template);
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

  const sent = await sendTelegramPreview(order, previewImageUrl, template);

  if (sent) {
    await supabase
      .from("orders")
      .update({
        bot_message_sent: true,
        bot_message_sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", order.id);
  }

  console.log("Order completed:", order.id);
}

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
  setInterval(checkTelegramUpdates, 3000);

  checkOrders();
  checkTelegramUpdates();
}

startWorker();