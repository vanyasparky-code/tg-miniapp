const { createClient } = require("@supabase/supabase-js");
const { execFile } = require("child_process");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
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

  console.log("Higgsfield credentials file created");
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CHECK_INTERVAL_MS = 15000;
const JOB_TIMEOUT_MS = 30 * 60 * 1000;
const JOB_POLL_MS = 20000;

function runHiggsfield(args) {
  return new Promise((resolve, reject) => {
    execFile(
      "npm",
      ["exec", "-y", "--package=@higgsfield/cli", "--", "higgsfield", ...args],
      {
env: {
  ...process.env,
  HIGGSFIELD_TOKEN: process.env.HIGGSFIELD_TOKEN,
  HIGGSFIELD_CLI_CACHE: "/tmp/higgsfield-cache"
},
        maxBuffer: 1024 * 1024 * 20
      },
      (error, stdout, stderr) => {
        if (error) {
          console.error("Higgsfield error:", stderr || error.message);
          reject(error);
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
    "--json"
  ]);

  if (!result.id) {
    throw new Error("Higgsfield upload did not return id");
  }

  return result;
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
        type: "media_input"
      }
    ]),
    "--aspect_ratio",
    aspectRatio || "9:16",
    "--resolution",
    "2k",
    "--json"
  ]);

  return Array.isArray(result) ? result[0] : result.id;
}

async function createSeedanceJob(uploadId, template) {
  const args = [
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
    "--json"
  ];

  const result = await runHiggsfield(args);

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
    "--json"
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

        if (job.status === "failed" || job.status === "error") {
          throw new Error(`Higgsfield job failed: ${jobId}`);
        }
      }

      temporaryErrors = 0;
    } catch (error) {
      temporaryErrors += 1;

      console.error(
        `Temporary Higgsfield list error ${temporaryErrors}/5:`,
        error.message
      );

      if (temporaryErrors >= 5) {
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, JOB_POLL_MS));
  }

  throw new Error(`Higgsfield job timeout: ${jobId}`);
}

async function processOrder(order) {
  console.log("Processing order:", order.id);

  await supabase
    .from("orders")
    .update({
      status: "processing",
      updated_at: new Date().toISOString()
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
      updated_at: new Date().toISOString()
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

  await supabase
    .from("orders")
    .update({
      video_url: videoUrl,
      status: "video_ready_locked",
      updated_at: new Date().toISOString()
    })
    .eq("id", order.id);

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
          updated_at: new Date().toISOString()
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