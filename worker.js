const { createClient } = require("@supabase/supabase-js");
const { execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs/promises");
const http = require("http");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;
const sharp = require("sharp");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CHECK_INTERVAL_MS = 15000;
const GENERATION_MAX_ATTEMPTS = 3;
const HIGGSFIELD_API_BASE_URL = "https://api.higgsfield.ai";
const HIGGSFIELD_POLL_INTERVAL_MS = 10000;
const HIGGSFIELD_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const GENJUTSU_POLL_TIMEOUT_MS = 30 * 60 * 1000;
const HIGGSFIELD_MODEL_DEBUG_ENDPOINTS = [
  "/agents/models",
  "/v1/models",
  "/models",
  "/v1/endpoints",
];
const DEFAULT_PHOTO_MODEL = "grok_imagine_2";
const DEFAULT_VIDEO_MODEL = "seedance_2";
const PHOTO_MODELS = {
  grok: "xai/grok-imagine-image-2.0",
  grok_imagine: "xai/grok-imagine-image-2.0",
  grok_imagine_2: "xai/grok-imagine-image-2.0",
  grok_imagine_2_0: "xai/grok-imagine-image-2.0",
  "xai/grok_imagine_image_2.0": "xai/grok-imagine-image-2.0",
  nano_banana: "xai/grok-imagine-image-2.0",
  nano_banana_2: "xai/grok-imagine-image-2.0",
  nano_banana_pro: "xai/grok-imagine-image-2.0",
  gpt_image_2: "gpt_image_2",
};
const VIDEO_MODEL_ALIASES = {
  seedance_2: "bytedance/seedance-2.0",
  seedance_2_0: "bytedance/seedance-2.0",
  kling_3: "kling-video/v3.0/std/image-to-video",
  kling_3_0: "kling-video/v3.0/std/image-to-video",
  kling_motion_control: "kling_motion_control",
  veo_3: "veo_3",
  wan_2_2: "wan_2_2",
  wan_2_5: "wan_2_5",
};
const TOKEN_PACKAGES = {
  "tokens-100": { id: "tokens-100", tokens: 100, priceRub: 106 },
  "tokens-300": { id: "tokens-300", tokens: 300, priceRub: 306 },
  "tokens-500": { id: "tokens-500", tokens: 500, priceRub: 496 },
  "tokens-700": { id: "tokens-700", tokens: 700, priceRub: 686 },
  "tokens-1000": { id: "tokens-1000", tokens: 1000, priceRub: 950 },
  "tokens-2000": { id: "tokens-2000", tokens: 2000, priceRub: 1794 },
  "tokens-5000": { id: "tokens-5000", tokens: 5000, priceRub: 4220 },
};
const TELEGRAM_INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;
const HIGGSFIELD_RETAIL_MULTIPLIER = 3;
const GENJUTSU_RETAIL_MULTIPLIER = 2;
const TOKEN_VALUE_RUB = 1;
const GENJUTSU_USD_RUB_RATE = 100;
const WEB_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const HISTORY_DOWNLOAD_MAX_AGE_SECONDS = 10 * 60;
const GENJUTSU_MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const GENJUTSU_MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const GENJUTSU_RATES_USD = Object.freeze({
  "480p": 0.159,
  "720p": 0.341,
  "1080p": 0.816,
});
const GENJUTSU_MODELS = Object.freeze({
  genjutsu_motion: {
    label: "Genjutsu · Motion Transfer",
    modelId: "higgsfield/genjutsu/motion-transfer/v1.0",
    minImages: 1,
    maxImages: 8,
  },
  genjutsu_object: {
    label: "Genjutsu · Object Swap",
    modelId: "higgsfield/genjutsu/object-swap/v1.0",
    minImages: 1,
    maxImages: 8,
    minimumPixels: 409600,
  },
  genjutsu_restyle: {
    label: "Genjutsu · Restyle",
    modelId: "higgsfield/genjutsu/restyle/v1.0",
    minImages: 0,
    maxImages: 5,
    requiresPreset: true,
  },
});
const MINI_APP_URL = "https://tg-miniapp-liart.vercel.app";
const RAP_IN_CAR_IDENTITY_PROMPT =
  "Strictly preserve the exact identity and natural appearance of every person from the uploaded reference images throughout the entire video. Each reference image represents one separate person: never blend, average, merge, or exchange facial or body features between people, and never mix them with the original actors. Reproduce each person's recognizable face exactly, including face shape, head shape, eyes, eyebrows, nose, lips, jawline, cheeks, ears, skin tone, facial hair, hairline, hairstyle, and hair color. Preserve each person's exact natural body parameters from their own reference: apparent height, weight, body build, shoulder width, chest, waist, neck, arms, legs, and overall proportions. Do not make anyone thinner, heavier, taller, shorter, younger, older, more muscular, or differently proportioned. Keep all identities, faces, and body proportions stable in every frame, including head turns, profile views, open-mouth singing, gestures, and motion blur. No face morphing, identity drift, hybrid faces, duplicated faces, or body-shape drift. Keep the existing character positions, actions, motion, timing, car interior, camera, framing, and lighting unchanged.";
const RAP_IN_CAR_DEFAULT_PROMPT =
  `${RAP_IN_CAR_IDENTITY_PROMPT} Preserve each person's original referenced clothing and accessories. Change only the original actors into the referenced people.`;
const RAP_IN_CAR_OUTFIT_PROMPT =
  `${RAP_IN_CAR_IDENTITY_PROMPT} Change only the clothing to four distinct early-2000s gangsta-rap outfits. Use oversized sports jerseys, baggy jeans, leather streetwear, tracksuits, caps or bandanas, bold chains, rings, and luxury watches. Give every character a different coordinated outfit and different accessories. Fit every outfit over the person's unchanged body without altering their build or proportions.`;
const ZOMBIE_DRAMA_PROMPT =
  "Edit the uploaded source video and replace only the two people. Keep everything else identical to the original: the same shots, cuts, timing, camera movement, lighting, locations, backgrounds, props, gun, wardrobe shapes, tear tracks, wind, sunset, color grade, film grain, framing, and performances. Keep it ultrarealistic live-action. No restyle, no new scenes, and no extra characters. Image 1 replaces the man in every shot. Lock the exact recognizable identity, face, hair, skin tone, age, height, body build, weight, and proportions from image 1. Use the same man in the dark house and in all golden-field memories. Map him precisely onto the original man's head position, eye line, crying, aiming, lowering the gun, opening his arms, smiling, running, and kissing. Never redesign, blend, or distort his face or body. Image 2 replaces the woman in every shot and must remain the same exact recognizable woman throughout. In the dark-house scenes only, render the woman from image 2 in the original infected state while preserving her exact facial structure and identity: keep the milky eyes, dirty cracked skin, snarl, torn clothes, and feral twitch from the original performance. In the memory scenes only, render the same woman from image 2 healthy, with her exact natural face, hair, skin tone, age, height, body build, weight, and proportions, while lying in the grass, laughing in close-up, running through the field, and sitting at sunset. Do not blend image 1 and image 2. Do not mix either identity with the original actors. Do not put the healthy face on the infected body or the infected appearance on the healthy memory woman. Maintain stable facial identity and body proportions in every frame, including profiles, motion, crying, smiling, running, and kissing. Do not change the windows, kitchen shelves, grass, sky, camera path, or scene composition. Preserve photorealistic skin contact, wet tears, and natural head tracking to the original motion.";
const TEMPLATE_GENERATION_VIDEO_OVERRIDES = Object.freeze({
  rap_in_car: `${MINI_APP_URL}/assets/templates/rap-in-car-generation.mp4`,
});
const SUPPORT_URL =
  process.env.SUPPORT_URL || "https://t.me/redaktop_support_bot";
const CHANNEL_URL = "https://t.me/neuro_video_repeat";
const BOT_WELCOME_IMAGE_URL = `${MINI_APP_URL}/assets/redaktop-logo.png`;
const BUILT_IN_TEMPLATE_ROWS = Object.freeze([
  Object.freeze({
    slug: "rap_in_car",
    title: "Рэп в машине",
    description: "Замените четырёх героев ролика своими фотографиями.",
    video_prompt: RAP_IN_CAR_DEFAULT_PROMPT,
    photo_prompt: "",
    price_rub: 1,
    is_active: true,
    cover_url: `${MINI_APP_URL}/assets/templates/rap-in-car-cover.jpg`,
    preview_video_url: `${MINI_APP_URL}/assets/templates/rap-in-car-preview.mp4`,
    source_video_url: `${MINI_APP_URL}/assets/templates/rap-in-car-source.mp4`,
    generation_mode: "genjutsu_motion_template",
    required_photo_count: 4,
    photo_rules: [
      "Человек слева спереди",
      "Человек справа спереди",
      "Человек слева сзади",
      "Человек справа сзади",
    ],
    available_resolutions: ["480p", "720p", "1080p"],
    photo_model: "none",
    video_model: "genjutsu_motion",
    aspect_ratio: "16:9",
    duration: 20.077,
    resolution: "480p",
  }),
  Object.freeze({
    slug: "zombie_drama",
    title: "Зомби драма",
    description: "Станьте героями драматичной истории о любви и зомби.",
    video_prompt: ZOMBIE_DRAMA_PROMPT,
    photo_prompt: "",
    price_rub: 1,
    is_active: true,
    cover_url: `${MINI_APP_URL}/assets/templates/zombie-drama-cover.jpg`,
    preview_video_url: `${MINI_APP_URL}/assets/templates/zombie-drama-preview.mp4`,
    source_video_url: `${MINI_APP_URL}/assets/templates/zombie-drama-source.mp4`,
    generation_mode: "genjutsu_motion_template",
    required_photo_count: 2,
    photo_rules: ["Мужчина", "Девушка"],
    available_resolutions: ["480p", "720p", "1080p"],
    photo_model: "none",
    video_model: "genjutsu_motion",
    aspect_ratio: "16:9",
    duration: 24.071,
    resolution: "480p",
  }),
]);
let telegramUpdateOffset = 0;
let supportTelegramUpdateOffset = 0;
let isCheckingSupportUpdates = false;
let isCheckingOrders = false;
let isCheckingCustomGenerations = false;
let usdRubRateCache = null;
let genjutsuPresetCache = null;

function calculateGenerationRetailPrice(
  providerCostUsd,
  usdRubRate,
  multiplier = HIGGSFIELD_RETAIL_MULTIPLIER
) {
  const costUsd = Number(providerCostUsd);
  const rubRate = Number(usdRubRate);

  if (!Number.isFinite(costUsd) || costUsd <= 0) {
    throw new Error(`Invalid Higgsfield provider cost: ${providerCostUsd}`);
  }

  if (!Number.isFinite(rubRate) || rubRate <= 0) {
    throw new Error(`Invalid USD/RUB rate: ${usdRubRate}`);
  }

  const providerCostRub = costUsd * rubRate;
  const normalizedMultiplier = Number(multiplier);

  if (!Number.isFinite(normalizedMultiplier) || normalizedMultiplier <= 0) {
    throw new Error(`Invalid retail multiplier: ${multiplier}`);
  }

  const retailPriceRub = providerCostRub * normalizedMultiplier;
  const priceTokens = Math.ceil(retailPriceRub / TOKEN_VALUE_RUB);

  return {
    providerCostUsd: Number(costUsd.toFixed(6)),
    providerCostRub: Number(providerCostRub.toFixed(2)),
    usdRubRate: Number(rubRate.toFixed(4)),
    multiplier: normalizedMultiplier,
    retailPriceRub: Number(retailPriceRub.toFixed(2)),
    priceTokens,
  };
}

function calculateGenjutsuPricing(durationSeconds, resolution) {
  const sourceDuration = Number(durationSeconds);
  const rateUsd = GENJUTSU_RATES_USD[resolution];

  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0 || !rateUsd) {
    throw createHttpError("Не удалось рассчитать стоимость видео", 400, "INVALID_VIDEO_PRICING");
  }

  const billedSeconds = Math.ceil(Math.min(sourceDuration, 30));
  const providerCostUsd = Number((billedSeconds * rateUsd).toFixed(6));
  const pricing = calculateGenerationRetailPrice(
    providerCostUsd,
    GENJUTSU_USD_RUB_RATE,
    GENJUTSU_RETAIL_MULTIPLIER
  );

  return { ...pricing, billedSeconds, resolution };
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getHiggsfieldCredentials() {
  const apiKeyId = process.env.HIGGSFIELD_API_KEY_ID;
  const apiKeySecret = process.env.HIGGSFIELD_API_KEY_SECRET;

  if (!apiKeyId) {
    throw new Error("Missing HIGGSFIELD_API_KEY_ID");
  }

  if (!apiKeySecret) {
    throw new Error("Missing HIGGSFIELD_API_KEY_SECRET");
  }

  return `${apiKeyId}:${apiKeySecret}`;
}

function getHiggsfieldUrl(pathname) {
  const baseUrl = HIGGSFIELD_API_BASE_URL.endsWith("/")
    ? HIGGSFIELD_API_BASE_URL
    : `${HIGGSFIELD_API_BASE_URL}/`;

  return new URL(pathname.replace(/^\/+/, ""), baseUrl).toString();
}

async function readJsonResponse(response) {
  const text = await response.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Higgsfield returned non-JSON response: ${text}`);
  }
}

function extractHiggsfieldError(data) {
  if (!data || typeof data !== "object") {
    return null;
  }

  if (typeof data.detail === "string") {
    return data.detail;
  }

  if (typeof data.message === "string") {
    return data.message;
  }

  if (typeof data.error === "string") {
    return data.error;
  }

  if (Array.isArray(data.detail)) {
    return data.detail
      .map((item) => item?.msg || item?.message || JSON.stringify(item))
      .join("; ");
  }

  if (typeof data.data?.detail === "string") {
    return data.data.detail;
  }

  if (typeof data.data?.message === "string") {
    return data.data.message;
  }

  if (typeof data.data?.error === "string") {
    return data.data.error;
  }

  return null;
}

async function higgsfieldRequest(pathname, options = {}) {
  const url = getHiggsfieldUrl(pathname);
  const debug = options.debug || null;

  if (debug) {
    console.log("HIGGSFIELD BASE URL:", HIGGSFIELD_API_BASE_URL);

    if (debug.photoModelId) {
      console.log("HIGGSFIELD PHOTO MODEL ID:", debug.photoModelId);
    }

    if (debug.payload) {
      console.log("HIGGSFIELD REQUEST:", JSON.stringify(debug.payload, null, 2));
    }
  }

  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Key ${getHiggsfieldCredentials()}`,
      "Content-Type": "application/json",
      "User-Agent": "tg-miniapp-higgsfield-api/1.0",
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();

  if (debug) {
    console.log("HIGGSFIELD RESPONSE STATUS:", response.status);
  }

  let data = {};

  if (text) {
    try {
      data = JSON.parse(text);
    } catch (parseError) {
      if (!response.ok) {
        console.error("HIGGSFIELD RESPONSE STATUS:", response.status);
        console.error("HIGGSFIELD RESPONSE BODY:", text);
        throw new Error(`Higgsfield API ${response.status}: ${text}`);
      }

      throw new Error(`Higgsfield returned non-JSON response: ${text}`);
    }
  }

  if (!response.ok) {
    console.error("HIGGSFIELD RESPONSE STATUS:", response.status);
    console.error("HIGGSFIELD RESPONSE BODY:", text);
    const detail = extractHiggsfieldError(data);
    throw new Error(
      `Higgsfield API ${response.status}: ${detail || JSON.stringify(data)}`
    );
  }

  return data;
}

function extractGenerationId(result) {
  return (
    result?.request_id ||
    result?.generation_id ||
    result?.job_id ||
    result?.id ||
    result?.data?.request_id ||
    result?.data?.generation_id ||
    result?.data?.job_id ||
    result?.data?.id
  );
}

function extractResultUrl(result) {
  return (
    result?.result_url ||
    result?.video_url ||
    result?.image_url ||
    result?.url ||
    result?.output_url ||
    result?.video?.url ||
    result?.images?.[0]?.url ||
    result?.result?.url ||
    result?.result?.video_url ||
    result?.result?.image_url ||
    result?.results?.[0]?.url ||
    result?.jobs?.[0]?.results?.raw?.url ||
    result?.data?.result_url ||
    result?.data?.video_url ||
    result?.data?.image_url ||
    result?.data?.video?.url ||
    result?.data?.images?.[0]?.url ||
    result?.data?.result?.url ||
    result?.data?.result?.video_url ||
    result?.data?.result?.image_url ||
    result?.data?.results?.[0]?.url
  );
}

async function createGeneration(modelId, payload) {
  const result = await higgsfieldRequest(modelId, {
    method: "POST",
    body: payload,
    debug: {
      photoModelId: modelId,
      payload,
    },
  });

  const generationId = extractGenerationId(result);

  if (!generationId) {
    throw new Error("Higgsfield createGeneration did not return generation_id");
  }

  console.log("generation_id", generationId);

  return {
    generationId,
    statusUrl: result?.status_url || result?.data?.status_url || null,
  };
}

async function pollGeneration(
  generationId,
  statusUrl = null,
  timeoutMs = HIGGSFIELD_POLL_TIMEOUT_MS
) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const result = await higgsfieldRequest(
      statusUrl || `/requests/${encodeURIComponent(generationId)}/status`
    );
    const status = result?.status || result?.data?.status;

    console.log("polling status", {
      generation_id: generationId,
      status,
    });

    if (status === "completed" || status === "succeeded") {
      const resultUrl = extractResultUrl(result);

      if (!resultUrl) {
        throw new Error(
          `Higgsfield generation completed but result_url is missing: ${generationId}`
        );
      }

      console.log("result_url", resultUrl);

      return resultUrl;
    }

    if (
      status === "failed" ||
      status === "error" ||
      status === "nsfw" ||
      status === "canceled" ||
      status === "cancelled"
    ) {
      const detail = extractHiggsfieldError(result);
      throw new Error(
        `Higgsfield generation ${generationId} failed with status ${status}${
          detail ? `: ${detail}` : ""
        }`
      );
    }

    await sleep(HIGGSFIELD_POLL_INTERVAL_MS);
  }

  throw new Error(`Higgsfield polling timeout: ${generationId}`);
}

async function runGenerationWithRetries(label, modelId, payload) {
  let lastError = null;

  for (let attempt = 1; attempt <= GENERATION_MAX_ATTEMPTS; attempt++) {
    try {
      console.log(`${label} attempt ${attempt}/${GENERATION_MAX_ATTEMPTS}`);

      const generation = await createGeneration(modelId, payload);
      return await pollGeneration(
        generation.generationId,
        generation.statusUrl
      );
    } catch (error) {
      lastError = error;
      console.error(`${label} attempt ${attempt} failed:`, error.message);

      if (attempt < GENERATION_MAX_ATTEMPTS) {
        console.log(`Retrying ${label} in 15 seconds...`);
        await sleep(15000);
      }
    }
  }

  throw new Error(
    `${label} failed after ${GENERATION_MAX_ATTEMPTS} attempts: ${lastError?.message}`
  );
}

function normalizeTemplateModel(model, defaultModel) {
  if (typeof model !== "string" || !model.trim()) {
    return defaultModel;
  }

  return model
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_");
}

function resolvePhotoModel(model) {
  const normalizedModel = normalizeTemplateModel(model, DEFAULT_PHOTO_MODEL);
  const resolvedModel = PHOTO_MODELS[normalizedModel];

  if (!resolvedModel) {
    throw new Error(
      `Unknown Higgsfield photo model: ${model}. Available mappings: ${Object.keys(
        PHOTO_MODELS
      ).join(", ")}`
    );
  }

  return resolvedModel;
}

function resolveVideoModel(model) {
  const normalizedModel = normalizeTemplateModel(model, DEFAULT_VIDEO_MODEL);
  const resolvedModel = VIDEO_MODEL_ALIASES[normalizedModel];

  if (!resolvedModel) {
    throw new Error(`Unsupported video model: ${model}`);
  }

  return resolvedModel;
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

async function uploadPreviewVideoToSupabase(previewPath, orderId) {
  const previewBuffer = await fs.readFile(previewPath);
  const storagePath = `previews/${orderId}.mp4`;

  const { error: uploadError } = await supabase.storage
    .from("media")
    .upload(storagePath, previewBuffer, {
      contentType: "video/mp4",
      upsert: true,
    });

  if (uploadError) {
    throw new Error(`Preview video upload failed: ${uploadError.message}`);
  }

  return supabase.storage.from("media").getPublicUrl(storagePath).data.publicUrl;
}

async function createBlurredVideoPreview(videoUrl, orderId) {
  console.log("Creating blurred video preview for order:", orderId);

  const videoPath = await downloadFile(videoUrl, `video-${orderId}.mp4`);
  const previewPath = path.join(os.tmpdir(), `preview-${orderId}.mp4`);

  await runCommand(ffmpegPath, [
    "-y",
    "-i",
    videoPath,
    "-vf",
    "boxblur=18:1",
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "28",
    "-an",
    "-movflags",
    "+faststart",
    previewPath,
  ]);

  const previewUrl = await uploadPreviewVideoToSupabase(previewPath, orderId);

  console.log("Blurred video preview ready:", previewUrl);

  return previewUrl;
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

async function createPreviewMedia(videoUrl, orderId, existingPreviewImageUrl) {
  try {
    const previewVideoUrl = await createBlurredVideoPreview(videoUrl, orderId);

    return {
      previewVideoUrl,
      previewImageUrl: existingPreviewImageUrl || null,
    };
  } catch (error) {
    console.error("Blurred video preview failed:", error.message);
  }

  return {
    previewVideoUrl: null,
    previewImageUrl:
      existingPreviewImageUrl || (await createBlurredPreview(videoUrl, orderId)),
  };
}
function isContentSafetyError(error) {
  const message = String(error?.message || error || "").toLowerCase();

  return (
    message.includes("nsfw") ||
    message.includes("content safety") ||
    message.includes("safety restriction")
  );
}

async function sendTelegramErrorMessage(order, generationError = null) {
  if (!process.env.BOT_TOKEN) {
    console.log("No BOT_TOKEN found, skipping error message");
    return false;
  }

  if (!order.telegram_user_id) {
    console.log("No telegram_user_id for error message:", order.id);
    return false;
  }

  try {
    const text = isContentSafetyError(generationError)
      ? "⚠️ Нейросеть не смогла обработать загруженные фотографии из-за ограничений безопасности.\n\nПопробуйте загрузить другие фото и запустить создание ещё раз."
      : "⚠️ Произошла ошибка генерации.\n\nПопробуйте снова, пожалуйста.";

    await telegramApi("sendMessage", {
      chat_id: order.telegram_user_id,
      text,
    });

    console.log("Telegram error message sent:", order.id);
    return true;
  } catch (error) {
    console.error("Error message send failed:", error.message);
    return false;
  }
}
async function isUserSubscribedToChannel(telegramUserId) {
  if (!process.env.CHANNEL_ID) {
    console.log("No CHANNEL_ID found, skipping subscription check");
    return true;
  }

  if (!telegramUserId) {
    return false;
  }

  try {
    const member = await telegramApi("getChatMember", {
      chat_id: process.env.CHANNEL_ID,
      user_id: telegramUserId,
    });

    const status = member.status;

    if (
      status === "creator" ||
      status === "administrator" ||
      status === "member"
    ) {
      return true;
    }

    if (status === "restricted" && member.is_member === true) {
      return true;
    }

    return false;
  } catch (error) {
    console.error("Subscription check failed:", error.message);
    return false;
  }
}

async function sendSubscriptionRequiredMessage(chatId, templateSlug = "dance_with_dog") {
  const channelLink = process.env.CHANNEL_LINK || "https://t.me/";

  await telegramApi("sendMessage", {
    chat_id: chatId,
    text:
      "🔒 Чтобы создать видео, сначала подпишитесь на канал.\n\n" +
      "После подписки вернитесь сюда и нажмите кнопку ещё раз.",
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "Подписаться на канал",
            url: channelLink,
          },
        ],
        [
          {
            text: "Я подписался — продолжить",
            url: `https://t.me/neuro_video_repeat_bot?start=${encodeURIComponent(
              templateSlug
            )}`,
          },
        ],
      ],
    },
  });
}
async function sendTelegramPreparingMessage(order) {
  if (!process.env.BOT_TOKEN) {
    console.log("No BOT_TOKEN found, skipping preparing message");
    return false;
  }

  if (!order.telegram_user_id) {
    console.log("No telegram_user_id for preparing message:", order.id);
    return false;
  }

  try {
    await telegramApi("sendMessage", {
      chat_id: order.telegram_user_id,
      text:
        "🎬 Ваше видео создаётся.\n\n" +
        "В скором времени бот пришлёт вам результат.",
    });

    console.log("Telegram preparing message sent:", order.id);
    return true;
  } catch (error) {
    console.error("Preparing message failed:", error.message);
    return false;
  }
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
    `Стоимость: ${template.price_stars || 1} ⭐ или ${template.price_rub || 299} ₽`;

  const replyMarkup = {
    inline_keyboard: [
      [
        {
          text: `Оплатить ${template.price_stars || 1} ⭐`,
          callback_data: `pay:${order.id}`,
        },
      ],
      [
        {
          text: `Оплатить ${template.price_rub || 299} ₽ картой / СБП`,
          callback_data: `card:${order.id}`,
        },
      ],
    ],
  };
  const previewVideoUrl = order.preview_video_url;
  const telegramMethod = previewVideoUrl ? "sendVideo" : "sendPhoto";
  const mediaPayload = previewVideoUrl
    ? {
        video: previewVideoUrl,
        supports_streaming: true,
      }
    : {
        photo: previewImageUrl,
      };

  if (!previewVideoUrl && !previewImageUrl) {
    throw new Error(`Order has no preview media: ${order.id}`);
  }

  const response = await fetch(
    `https://api.telegram.org/bot${process.env.BOT_TOKEN}/${telegramMethod}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: order.telegram_user_id,
        ...mediaPayload,
        caption,
        reply_markup: replyMarkup,
      }),
    }
  );

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(`Telegram ${telegramMethod} failed: ${JSON.stringify(data)}`);
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

async function supportTelegramApi(method, payload) {
  if (!process.env.SUPPORT_BOT_TOKEN) {
    return null;
  }

  const response = await fetch(
    `https://api.telegram.org/bot${process.env.SUPPORT_BOT_TOKEN}/${method}`,
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
    throw new Error(
      `Telegram support API ${method} failed: ${JSON.stringify(data)}`
    );
  }

  return data.result;
}

function getSupportOperatorChatIds() {
  const configuredIds =
    process.env.SUPPORT_OPERATOR_CHAT_IDS ||
    process.env.SUPPORT_OPERATOR_CHAT_ID ||
    "";

  return String(configuredIds)
    .split(/[\s,;]+/)
    .map((value) => value.trim())
    .filter((value) => /^-?\d+$/.test(value));
}

function isSupportOperator(chatId) {
  return getSupportOperatorChatIds().includes(String(chatId));
}

function escapeTelegramHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function saveSupportMessageRoute({
  operatorChatId,
  operatorMessageId,
  userChatId,
  userTelegramId,
  username,
}) {
  const { error } = await supabase.from("support_message_routes").upsert(
    {
      operator_chat_id: String(operatorChatId),
      operator_message_id: operatorMessageId,
      user_chat_id: String(userChatId),
      user_telegram_id: userTelegramId ? String(userTelegramId) : null,
      username: username || null,
    },
    { onConflict: "operator_chat_id,operator_message_id" }
  );

  if (error) {
    throw new Error(`Support route save failed: ${error.message}`);
  }
}

async function findSupportMessageRoute(operatorChatId, operatorMessageId) {
  const { data, error } = await supabase
    .from("support_message_routes")
    .select("user_chat_id")
    .eq("operator_chat_id", String(operatorChatId))
    .eq("operator_message_id", operatorMessageId)
    .maybeSingle();

  if (error) {
    throw new Error(`Support route lookup failed: ${error.message}`);
  }

  return data;
}

async function handleSupportOperatorMessage(message) {
  const operatorChatId = message.chat.id;
  const text = message.text || "";

  if (text.startsWith("/start")) {
    await supportTelegramApi("sendMessage", {
      chat_id: operatorChatId,
      text:
        "Режим оператора поддержки активен.\n\n" +
        "Чтобы ответить клиенту, нажмите Reply на его сообщение и отправьте текст, фото, видео, голосовое или файл.",
    });
    return;
  }

  if (text.startsWith("/id")) {
    await supportTelegramApi("sendMessage", {
      chat_id: operatorChatId,
      text: `Ваш Telegram ID: <code>${operatorChatId}</code>`,
      parse_mode: "HTML",
    });
    return;
  }

  const repliedMessageId = message.reply_to_message?.message_id;

  if (!repliedMessageId) {
    await supportTelegramApi("sendMessage", {
      chat_id: operatorChatId,
      text: "Чтобы ответить клиенту, используйте Reply на его сообщении.",
    });
    return;
  }

  const route = await findSupportMessageRoute(
    operatorChatId,
    repliedMessageId
  );

  if (!route) {
    await supportTelegramApi("sendMessage", {
      chat_id: operatorChatId,
      text:
        "Не удалось определить клиента для этого сообщения. Ответьте через Reply на сообщение обращения, которое прислал бот.",
    });
    return;
  }

  await supportTelegramApi("copyMessage", {
    chat_id: route.user_chat_id,
    from_chat_id: operatorChatId,
    message_id: message.message_id,
  });

  await supportTelegramApi("sendMessage", {
    chat_id: operatorChatId,
    text: "✅ Ответ отправлен клиенту.",
  });
}

async function handleSupportCustomerMessage(message) {
  const userChatId = message.chat.id;
  const text = message.text || "";

  if (text.startsWith("/start")) {
    await supportTelegramApi("sendMessage", {
      chat_id: userChatId,
      text:
        "Здравствуйте! Это поддержка REDAKTOP.\n\n" +
        "Опишите вопрос одним сообщением. Можно прикрепить фото, видео, голосовое сообщение или файл. Мы ответим здесь.",
    });
    return;
  }

  if (text.startsWith("/id")) {
    await supportTelegramApi("sendMessage", {
      chat_id: userChatId,
      text: `Ваш Telegram ID: <code>${userChatId}</code>`,
      parse_mode: "HTML",
    });
    return;
  }

  const operatorChatIds = getSupportOperatorChatIds();

  if (operatorChatIds.length === 0) {
    await supportTelegramApi("sendMessage", {
      chat_id: userChatId,
      text:
        "Поддержка сейчас подключается. Пожалуйста, попробуйте отправить сообщение немного позже.",
    });
    console.warn("Support message received without configured operator");
    return;
  }

  const firstName = escapeTelegramHtml(message.from?.first_name);
  const lastName = escapeTelegramHtml(message.from?.last_name);
  const fullName = [firstName, lastName].filter(Boolean).join(" ") || "Без имени";
  const username = message.from?.username || null;
  let deliveredCount = 0;

  for (const operatorChatId of operatorChatIds) {
    try {
      const header = await supportTelegramApi("sendMessage", {
        chat_id: operatorChatId,
        text:
          "🆕 <b>Новое обращение</b>\n" +
          `<b>Клиент:</b> ${fullName}\n` +
          `<b>Username:</b> ${
            username ? `@${escapeTelegramHtml(username)}` : "не указан"
          }\n` +
          `<b>Telegram ID:</b> <code>${message.from?.id || userChatId}</code>\n\n` +
          "Ответьте через Reply на это сообщение или на сообщение клиента ниже.",
        parse_mode: "HTML",
      });

      await saveSupportMessageRoute({
        operatorChatId,
        operatorMessageId: header.message_id,
        userChatId,
        userTelegramId: message.from?.id,
        username,
      });

      const copiedMessage = await supportTelegramApi("copyMessage", {
        chat_id: operatorChatId,
        from_chat_id: userChatId,
        message_id: message.message_id,
        reply_parameters: {
          message_id: header.message_id,
        },
      });

      await saveSupportMessageRoute({
        operatorChatId,
        operatorMessageId: copiedMessage.message_id,
        userChatId,
        userTelegramId: message.from?.id,
        username,
      });

      deliveredCount += 1;
    } catch (error) {
      console.error(
        `Support delivery to operator ${operatorChatId} failed:`,
        error.message
      );
    }
  }

  await supportTelegramApi("sendMessage", {
    chat_id: userChatId,
    text:
      deliveredCount > 0
        ? "✅ Сообщение передано в поддержку. Ответ придёт в этот чат."
        : "Не удалось передать сообщение. Пожалуйста, попробуйте ещё раз немного позже.",
  });
}

async function handleSupportMessage(message) {
  if (
    !message ||
    message.from?.is_bot ||
    message.chat?.type !== "private"
  ) {
    return;
  }

  if (isSupportOperator(message.chat.id)) {
    await handleSupportOperatorMessage(message);
    return;
  }

  await handleSupportCustomerMessage(message);
}

async function configureSupportTelegramBot() {
  if (!process.env.SUPPORT_BOT_TOKEN) {
    console.log("Support bot is disabled: no SUPPORT_BOT_TOKEN");
    return;
  }

  await supportTelegramApi("deleteWebhook", { drop_pending_updates: false });

  const setupCalls = [
    supportTelegramApi("setMyCommands", {
      commands: [
        { command: "start", description: "Начать обращение" },
        { command: "id", description: "Показать мой Telegram ID" },
      ],
    }),
  ];

  const results = await Promise.allSettled(setupCalls);
  const failures = results.filter((result) => result.status === "rejected");

  if (failures.length) {
    console.error(
      "Support bot presentation setup failed:",
      failures.map((result) => result.reason?.message || String(result.reason))
    );
    return;
  }

  console.log("Support bot configured");
}

async function checkSupportTelegramUpdates() {
  if (!process.env.SUPPORT_BOT_TOKEN || isCheckingSupportUpdates) {
    return;
  }

  isCheckingSupportUpdates = true;

  try {
    const updates = await supportTelegramApi("getUpdates", {
      offset: supportTelegramUpdateOffset,
      timeout: 0,
      allowed_updates: ["message"],
    });

    for (const update of updates || []) {
      supportTelegramUpdateOffset = update.update_id + 1;

      if (!update.message) {
        continue;
      }

      try {
        await handleSupportMessage(update.message);
      } catch (error) {
        console.error("Support message handling failed:", error.message);
      }
    }
  } catch (error) {
    console.error("Support bot updates error:", error.message);
  } finally {
    isCheckingSupportUpdates = false;
  }
}

async function configureTelegramBot() {
  if (!process.env.BOT_TOKEN) {
    return;
  }

  const setupCalls = [
    telegramApi("setMyCommands", {
      commands: [{ command: "start", description: "Открыть REDAKTOP" }],
    }),
    telegramApi("setChatMenuButton", {
      menu_button: {
        type: "web_app",
        text: "Открыть REDAKTOP",
        web_app: { url: MINI_APP_URL },
      },
    }),
  ];

  const results = await Promise.allSettled(setupCalls);
  const failures = results.filter((result) => result.status === "rejected");

  if (failures.length) {
    console.error(
      "Telegram bot presentation setup failed:",
      failures.map((result) => result.reason?.message || String(result.reason))
    );
    return;
  }

  console.log("Telegram bot presentation configured");
}

async function answerCallbackQuery(callbackQueryId, text) {
  await telegramApi("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: true,
  });
}

function getRobokassaConfig() {
  const merchantLogin = process.env.ROBOKASSA_MERCHANT_LOGIN;
  const password1 = process.env.ROBOKASSA_PASSWORD1;
  const password2 = process.env.ROBOKASSA_PASSWORD2;
  const hashAlgorithm = String(
    process.env.ROBOKASSA_HASH_ALGORITHM || "md5"
  )
    .trim()
    .toLowerCase()
    .replace(/-/g, "");

  if (!merchantLogin || !password1 || !password2) {
    throw new Error("Robokassa env vars are not configured");
  }

  if (!["md5", "sha1", "sha256", "sha384", "sha512"].includes(hashAlgorithm)) {
    throw new Error(
      `Unsupported ROBOKASSA_HASH_ALGORITHM: ${hashAlgorithm}`
    );
  }

  return {
    merchantLogin,
    password1,
    password2,
    hashAlgorithm,
    isTest: ["1", "true", "yes"].includes(
      String(process.env.ROBOKASSA_TEST || "").toLowerCase()
    ),
  };
}

function robokassaHashHex(value, hashAlgorithm) {
  return crypto.createHash(hashAlgorithm).update(value).digest("hex");
}

function formatRobokassaOutSum(priceRub) {
  const amount = Number(priceRub || 299);

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Invalid Robokassa amount: ${priceRub}`);
  }

  return amount.toFixed(2);
}

function createRobokassaInvoiceId(orderId) {
  const hashSuffix = parseInt(
    crypto.createHash("sha1").update(String(orderId)).digest("hex").slice(0, 8),
    16
  ) % 100000;

  return `${Date.now()}${String(hashSuffix).padStart(5, "0")}`;
}

function getShpSignatureTail(params) {
  return Object.entries(params)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${key}=${value}`)
    .join(":");
}

function createRobokassaPaymentUrl(order) {
  const { merchantLogin, password1, hashAlgorithm, isTest } =
    getRobokassaConfig();
  const outSum = formatRobokassaOutSum(order.price_rub);
  const invId = createRobokassaInvoiceId(order.id);
  const shpParams = {
    Shp_orderId: String(order.id),
  };
  const shpTail = getShpSignatureTail(shpParams);
  const signatureBase = `${merchantLogin}:${outSum}:${invId}:${password1}:${shpTail}`;
  const signature = robokassaHashHex(signatureBase, hashAlgorithm);
  const paymentUrl = new URL("https://auth.robokassa.ru/Merchant/Index.aspx");

  paymentUrl.searchParams.set("MerchantLogin", merchantLogin);
  paymentUrl.searchParams.set("OutSum", outSum);
  paymentUrl.searchParams.set("InvId", invId);
  paymentUrl.searchParams.set("Description", `Оплата заказа ${order.id}`);
  paymentUrl.searchParams.set("SignatureValue", signature);
  paymentUrl.searchParams.set("Culture", "ru");

  for (const [key, value] of Object.entries(shpParams)) {
    paymentUrl.searchParams.set(key, value);
  }

  if (isTest) {
    paymentUrl.searchParams.set("IsTest", "1");
  }

  console.log("Robokassa payment URL created:", {
    orderId: order.id,
    invId,
    isTest,
    hashAlgorithm,
  });

  return paymentUrl.toString();
}

function createRobokassaTokenPaymentUrl(payment) {
  const { merchantLogin, password1, hashAlgorithm, isTest } =
    getRobokassaConfig();
  const outSum = formatRobokassaOutSum(payment.amount_rub);
  const invId = payment.robokassa_inv_id || createRobokassaInvoiceId(payment.id);
  const shpParams = {
    Shp_paymentId: String(payment.id),
    Shp_paymentType: "tokens",
  };
  const shpTail = getShpSignatureTail(shpParams);
  const signatureBase = `${merchantLogin}:${outSum}:${invId}:${password1}:${shpTail}`;
  const signature = robokassaHashHex(signatureBase, hashAlgorithm);
  const paymentUrl = new URL("https://auth.robokassa.ru/Merchant/Index.aspx");

  paymentUrl.searchParams.set("MerchantLogin", merchantLogin);
  paymentUrl.searchParams.set("OutSum", outSum);
  paymentUrl.searchParams.set("InvId", invId);
  paymentUrl.searchParams.set(
    "Description",
    `Redaktop ai: ${payment.tokens} токенов`
  );
  paymentUrl.searchParams.set("SignatureValue", signature);
  paymentUrl.searchParams.set("Culture", "ru");

  for (const [key, value] of Object.entries(shpParams)) {
    paymentUrl.searchParams.set(key, value);
  }

  if (isTest) {
    paymentUrl.searchParams.set("IsTest", "1");
  }

  console.log("Robokassa token payment URL created:", {
    paymentId: payment.id,
    tokens: payment.tokens,
    invId,
    isTest,
  });

  return { paymentUrl: paymentUrl.toString(), invId };
}

async function sendRobokassaPaymentLink(chatId, order) {
  const paymentUrl = createRobokassaPaymentUrl(order);

  await telegramApi("sendMessage", {
    chat_id: chatId,
    text:
      `✅ Оферта подтверждена.\n\n` +
      `Нажмите кнопку ниже, чтобы оплатить ${order.price_rub || 299} ₽ картой или через СБП.`,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "Оплатить через Robokassa",
            url: paymentUrl,
          },
        ],
      ],
    },
  });
}

async function handleCardCallback(callbackQuery) {
  const callbackData = callbackQuery.data || "";

  if (!callbackData.startsWith("card:")) {
    return;
  }

  const orderId = callbackData.replace("card:", "");
  const chatId = callbackQuery.message?.chat?.id;

  console.log("Card payment button clicked:", {
    orderId,
    chatId,
    fromUserId: callbackQuery.from?.id,
  });

  const { data: order, error } = await supabase
    .from("orders")
    .select(
      "id, status, paid, video_url, telegram_user_id, price_rub, price_stars"
    )
    .eq("id", orderId)
    .single();

  if (error || !order) {
    await answerCallbackQuery(callbackQuery.id, "Заказ не найден.");
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
    await answerCallbackQuery(callbackQuery.id, "Видео ещё не готово.");
    return;
  }

  await answerCallbackQuery(callbackQuery.id, "Перед оплатой подтвердите оферту.");

  await sendOfferConfirmationMessage(chatId, order);
}
async function sendOfferConfirmationMessage(chatId, order) {
  const offerUrl =
    process.env.OFFER_URL ||
    `${MINI_APP_URL}/offer.html`;

  await telegramApi("sendMessage", {
    chat_id: chatId,
    text:
      `💳 Оплата картой / СБП\n\n` +
      `Стоимость: ${order.price_rub || 299} ₽\n\n` +
      `Перед оплатой ознакомьтесь с офертой.`,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "📄 Открыть оферту",
            url: offerUrl,
          },
        ],
        [
          {
            text: "✅ С офертой ознакомлен",
            callback_data: `offer_ok:${order.id}`,
          },
        ],
      ],
    },
  });
}
async function handleOfferOkCallback(callbackQuery) {
  const callbackData = callbackQuery.data || "";

  if (!callbackData.startsWith("offer_ok:")) {
    return;
  }

  const orderId = callbackData.replace("offer_ok:", "");
  const chatId = callbackQuery.message?.chat?.id;

  const { data: order, error } = await supabase
    .from("orders")
    .select(
      "id, status, paid, video_url, telegram_user_id, price_rub"
    )
    .eq("id", orderId)
    .single();

  if (error || !order) {
    await answerCallbackQuery(callbackQuery.id, "Заказ не найден.");
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
    await answerCallbackQuery(callbackQuery.id, "Видео ещё не готово.");
    return;
  }

  await answerCallbackQuery(callbackQuery.id, "Оферта подтверждена.");

  await supabase
    .from("orders")
    .update({
      offer_accepted: true,
      offer_accepted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", order.id);

  await sendRobokassaPaymentLink(chatId, order);
}
async function sendTelegramMessage(chatId, text) {
  await telegramApi("sendMessage", {
    chat_id: chatId,
    text,
  });
}
async function sendStarsInvoice(chatId, order) {
  const priceStars = Number(order.price_stars || 1);

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
    .select("id, status, paid, video_url, telegram_user_id, price_rub, price_stars")
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
  const templateSlug = parts[1] || "dance_with_dog";
  const chatId = message.chat.id;

  console.log("Start command received:", {
    chatId,
    templateSlug,
  });

  const subscribed = await isUserSubscribedToChannel(chatId);

  if (!subscribed) {
    await sendSubscriptionRequiredMessage(chatId, templateSlug);
    return;
  }

  await telegramApi("sendPhoto", {
    chat_id: chatId,
    photo: BOT_WELCOME_IMAGE_URL,
    caption:
      "<b>REDAKTOP</b> — нейросети в одном приложении\n\n" +
      "Повторяй понравившиеся тренды\n" +
      "Создавай видео с нуля, используя промт и референсы\n\n" +
      "⚡ Идея → пара кликов → результат.",
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "Открыть REDAKTOP",
            web_app: {
              url: `${MINI_APP_URL}?template=${encodeURIComponent(
                templateSlug
              )}`,
            },
          },
        ],
        [
          { text: "Поддержка", url: SUPPORT_URL },
          { text: "Канал", url: CHANNEL_URL },
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
  await handleCardCallback(update.callback_query);
  await handleOfferOkCallback(update.callback_query);
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
function getOrderPhotoUrls(order) {
  const photoUrls = Array.isArray(order.original_photo_urls)
    ? order.original_photo_urls
    : [];
  const normalizedPhotoUrls = photoUrls.filter(
    (url) => typeof url === "string" && url.trim()
  );

  if (normalizedPhotoUrls.length > 0) {
    return normalizedPhotoUrls;
  }

  if (typeof order.original_photo_url === "string" && order.original_photo_url) {
    return [order.original_photo_url];
  }

  return [];
}

function getTemplateInteger(value, fallback) {
  const number = Number(value);

  if (Number.isInteger(number) && number > 0) {
    return number;
  }

  return fallback;
}

function getTemplateText(value, fallback) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  return fallback;
}

function getTemplateObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    try {
      const parsedValue = JSON.parse(value);

      if (
        parsedValue &&
        typeof parsedValue === "object" &&
        !Array.isArray(parsedValue)
      ) {
        return parsedValue;
      }
    } catch (error) {
      console.error("Invalid template video_params JSON:", error.message);
    }
  }

  return {};
}

function hasTemplateParams(params) {
  return Object.keys(params).length > 0;
}

function getModelSpecificVideoParams(params, excludedKeys = []) {
  const excluded = new Set(excludedKeys);
  const modelParams = {};

  for (const [key, value] of Object.entries(params)) {
    if (excluded.has(key) || value === null || value === undefined) {
      continue;
    }

    modelParams[key] = value;
  }

  return modelParams;
}

async function createPhotoGeneration(model, prompt, photoUrls) {
  if (
    model === "xai/grok-imagine-image-2.0" &&
    photoUrls.length > 10
  ) {
    throw new Error("Grok Imagine 2.0 accepts at most 10 input photos");
  }

  const payload = {
    prompt,
    image_urls: photoUrls,
    quality: "medium",
    aspect_ratio: "9:16",
    resolution: "2k",
  };

  return runGenerationWithRetries(
    "Photo generation",
    model,
    payload
  );
}

function buildBaseVideoPayload(prompt, duration, resolution, aspectRatio) {
  return {
    prompt,
    aspect_ratio: aspectRatio,
    duration,
    resolution,
  };
}

function pickModelParams(params, keys) {
  const selected = {};

  for (const key of keys) {
    if (params[key] !== null && params[key] !== undefined) {
      selected[key] = params[key];
    }
  }

  return selected;
}

function buildSeedanceVideoRequest(
  prompt,
  imageUrl,
  duration,
  resolution,
  aspectRatio,
  options = {}
) {
  const videoParams = getTemplateObject(options.videoParams);
  const commonPayload = {
    prompt,
    duration,
    resolution,
    generate_audio:
      typeof videoParams.generate_audio === "boolean"
        ? videoParams.generate_audio
        : true,
  };

  if (options.imageMode === "start_frame") {
    console.log("Video image mode: start_frame");

    return {
      model: "bytedance/seedance-2.0/image-to-video",
      payload: {
        ...commonPayload,
        image_url: imageUrl,
      },
    };
  }

  console.log("Video image mode: reference");

  return {
    model: "bytedance/seedance-2.0/reference-to-video",
    payload: {
      ...commonPayload,
      ...pickModelParams(videoParams, ["audio_urls", "video_urls"]),
      image_urls: [imageUrl],
      aspect_ratio: aspectRatio,
    },
  };
}

function buildKlingVideoRequest(
  model,
  prompt,
  imageUrl,
  duration,
  options = {}
) {
  const videoParams = getTemplateObject(options.videoParams);

  return {
    model,
    payload: {
      prompt,
      duration,
      image_url: imageUrl,
      sound: getTemplateText(videoParams.sound, "on"),
      cfg_scale:
        typeof videoParams.cfg_scale === "number"
          ? videoParams.cfg_scale
          : 0.5,
      multi_shots:
        typeof videoParams.multi_shots === "boolean"
          ? videoParams.multi_shots
          : false,
      ...pickModelParams(videoParams, [
        "elements",
        "multi_prompt",
        "last_image_url",
      ]),
    },
  };
}

function buildGenericVideoRequest(
  model,
  prompt,
  imageUrl,
  duration,
  resolution,
  aspectRatio,
  options = {}
) {
  const videoParams = getTemplateObject(options.videoParams);
  const payload = {
    ...buildBaseVideoPayload(prompt, duration, resolution, aspectRatio),
    ...getModelSpecificVideoParams(videoParams, [
      "prompt",
      "aspect_ratio",
      "duration",
      "resolution",
      "image",
      "image_url",
      "medias",
      "mode",
      "genre",
    ]),
  };

  payload.image_url = imageUrl;

  return { model, payload };
}

function buildVideoRequest(
  model,
  prompt,
  imageUrl,
  duration,
  resolution,
  aspectRatio,
  options = {}
) {
  if (model === "bytedance/seedance-2.0") {
    return buildSeedanceVideoRequest(
      prompt,
      imageUrl,
      duration,
      resolution,
      aspectRatio,
      options
    );
  }

  if (model === "kling-video/v3.0/std/image-to-video") {
    return buildKlingVideoRequest(
      model,
      prompt,
      imageUrl,
      duration,
      options
    );
  }

  return buildGenericVideoRequest(
    model,
    prompt,
    imageUrl,
    duration,
    resolution,
    aspectRatio,
    options
  );
}

async function debugListHiggsfieldModels() {
  for (const endpoint of HIGGSFIELD_MODEL_DEBUG_ENDPOINTS) {
    const url = getHiggsfieldUrl(endpoint);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Key ${getHiggsfieldCredentials()}`,
          "Content-Type": "application/json",
          "User-Agent": "tg-miniapp-higgsfield-api/1.0",
        },
        body: JSON.stringify({}),
      });
      const body = await response.text();

      console.log("HIGGSFIELD MODELS DEBUG URL:", url);
      console.log("HIGGSFIELD MODELS DEBUG ENDPOINT:", endpoint);
      console.log("HIGGSFIELD MODELS DEBUG STATUS:", response.status);

      if (response.status === 405) {
        console.log(
          "HIGGSFIELD MODELS DEBUG ALLOW:",
          response.headers.get("allow") || ""
        );
      }

      if (response.ok) {
        console.log("HIGGSFIELD MODELS DEBUG BODY:", body);
      }
    } catch (error) {
      console.error("HIGGSFIELD MODELS DEBUG URL:", url);
      console.error("HIGGSFIELD MODELS DEBUG ENDPOINT:", endpoint);
      console.error("HIGGSFIELD MODELS DEBUG FAILED:", error.message);
    }
  }
}

async function createVideoGeneration(
  model,
  prompt,
  enhancedPhoto,
  duration,
  resolution,
  aspectRatio,
  options = {}
) {
  const request = buildVideoRequest(
    model,
    prompt,
    enhancedPhoto,
    duration,
    resolution,
    aspectRatio,
    options
  );

  return runGenerationWithRetries(
    "Video generation",
    request.model,
    request.payload
  );
}

async function refundOrderTokens(order, reason) {
  if (!order?.paid) {
    return null;
  }

  const { data, error } = await supabase.rpc("refund_order_tokens", {
    p_order_id: order.id,
    p_reason: String(reason || "generation_failed").slice(0, 500),
  });

  if (error) {
    throw new Error(`Order token refund failed: ${error.message}`);
  }

  const result = Array.isArray(data) ? data[0] : data;
  console.log("Order token refund:", {
    orderId: order.id,
    refunded: Boolean(result?.refunded),
    balance: result?.new_balance,
  });

  return result;
}

async function processGenjutsuTemplateOrder(order, template) {
  const photoUrls = getOrderPhotoUrls(order);
  const requiredPhotoCount = Math.max(
    1,
    Number(template.required_photo_count || 1)
  );

  if (photoUrls.length !== requiredPhotoCount) {
    throw new Error(
      `Template ${template.slug} requires exactly ${requiredPhotoCount} photos`
    );
  }

  const sourceVideoUrl = String(
    TEMPLATE_GENERATION_VIDEO_OVERRIDES[template.slug] ||
      template.source_video_url ||
      ""
  ).trim();

  if (!sourceVideoUrl) {
    throw new Error(`Template source video is missing: ${template.slug}`);
  }

  const availableResolutions = Array.isArray(template.available_resolutions)
    ? template.available_resolutions.map(String)
    : [String(template.resolution || "720p")];
  const resolution = String(
    order.selected_resolution || template.resolution || "720p"
  );

  if (!availableResolutions.includes(resolution)) {
    throw new Error(`Unsupported template resolution: ${resolution}`);
  }

  const now = new Date().toISOString();
  await supabase
    .from("orders")
    .update({
      status: "processing",
      price_rub: getTemplateTokenPrice(template, resolution),
      updated_at: now,
    })
    .eq("id", order.id);

  if (!order.bot_prepare_message_sent) {
    const prepareSent = await sendTelegramPreparingMessage(order);

    if (prepareSent) {
      await supabase
        .from("orders")
        .update({
          bot_prepare_message_sent: true,
          bot_prepare_message_sent_at: now,
          updated_at: now,
        })
        .eq("id", order.id);
    }
  }

  let requestId = order.provider_request_id;
  let statusUrl = order.provider_status_url;

  if (!requestId) {
    const prompt =
      template.slug === "rap_in_car"
        ? order.template_options?.rapper_outfit === true
          ? RAP_IN_CAR_OUTFIT_PROMPT
          : RAP_IN_CAR_DEFAULT_PROMPT
        : String(template.video_prompt || "").trim();
    const generationInput = {
      video_url: sourceVideoUrl,
      image_urls: photoUrls,
      resolution,
    };

    if (prompt) {
      generationInput.prompt = prompt;
    }

    const request = await createGeneration(
      GENJUTSU_MODELS.genjutsu_motion.modelId,
      generationInput
    );
    requestId = request.generationId;
    statusUrl = request.statusUrl;

    const { error: requestSaveError } = await supabase
      .from("orders")
      .update({
        provider_request_id: requestId,
        provider_status_url: statusUrl,
        updated_at: new Date().toISOString(),
      })
      .eq("id", order.id);

    if (requestSaveError) {
      throw new Error(
        `Failed to save template generation request: ${requestSaveError.message}`
      );
    }
  }

  const videoUrl = await pollGeneration(
    requestId,
    statusUrl,
    GENJUTSU_POLL_TIMEOUT_MS
  );
  const completedAt = new Date().toISOString();
  const { error: completeError } = await supabase
    .from("orders")
    .update({
      status: "completed",
      video_url: videoUrl,
      error_message: null,
      updated_at: completedAt,
    })
    .eq("id", order.id);

  if (completeError) {
    throw new Error(`Failed to save template result: ${completeError.message}`);
  }

  try {
    await sendTelegramVideo(order.telegram_user_id, videoUrl);
    await supabase
      .from("orders")
      .update({
        bot_message_sent: true,
        bot_message_sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", order.id);
  } catch (error) {
    console.error("Template video delivery failed:", order.id, error.message);
  }
}

async function processOrder(order) {
  console.log("Processing order:", order.id);

  if (order.paid && order.status === "completed" && order.video_url) {
    if (!order.bot_message_sent) {
      try {
        await sendTelegramVideo(order.telegram_user_id, order.video_url);
        await supabase
          .from("orders")
          .update({
            bot_message_sent: true,
            bot_message_sent_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", order.id);
      } catch (error) {
        console.error("Paid video delivery retry failed:", order.id, error.message);
      }
    }

    console.log("Recovered paid completed order:", order.id);
    return;
  }

  const subscribed = await isUserSubscribedToChannel(order.telegram_user_id);

  if (!subscribed) {
    console.log("User is not subscribed, stopping order:", order.id);

    await sendSubscriptionRequiredMessage(
      order.telegram_user_id,
      order.template_slug
    );

    if (order.paid) {
      await refundOrderTokens(order, "subscription_required");
    }

    await supabase
      .from("orders")
      .update({
        status: "subscription_required",
        error_message: "User is not subscribed to the channel",
        updated_at: new Date().toISOString(),
      })
      .eq("id", order.id);

    return;
  }

  const { data: template, error: templateError } = await supabase
    .from("templates")
    .select("*")
    .eq("slug", order.template_slug)
    .single();

  if (templateError || !template) {
    throw new Error(`Template not found: ${order.template_slug}`);
  }

  if (template.generation_mode === "genjutsu_motion_template") {
    await processGenjutsuTemplateOrder(order, template);
    return;
  }

  if (order.status === "video_ready_locked" && order.video_url) {
  console.log("Recovering video_ready_locked order:", order.id);

  let previewVideoUrl = order.preview_video_url;
  let previewImageUrl = order.preview_image_url;

  if (!previewVideoUrl) {
    const previewMedia = await createPreviewMedia(
      order.video_url,
      order.id,
      previewImageUrl
    );
    previewVideoUrl = previewMedia.previewVideoUrl;
    previewImageUrl = previewMedia.previewImageUrl;

    const previewUpdate = {
      updated_at: new Date().toISOString(),
    };

    if (previewVideoUrl) {
      previewUpdate.preview_video_url = previewVideoUrl;
    }

    if (previewImageUrl) {
      previewUpdate.preview_image_url = previewImageUrl;
    }

    await supabase
      .from("orders")
      .update(previewUpdate)
      .eq("id", order.id);
  }

  if (!order.bot_message_sent) {
    const sent = await sendTelegramPreview(
      {
        ...order,
        preview_video_url: previewVideoUrl,
      },
      previewImageUrl,
      template
    );

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
  }

  console.log("Recovered completed order:", order.id);
  return;
}
const resolvedPhotoModel = resolvePhotoModel(template.photo_model);
const resolvedVideoModel = resolveVideoModel(template.video_model);
const videoDuration = getTemplateInteger(template.duration, 5);
const videoResolution = getTemplateText(template.resolution, "720p");
const videoAspectRatio = getTemplateText(template.aspect_ratio, "16:9");

console.log("PHOTO MODEL RAW:", template.photo_model);
console.log("Photo model:", resolvedPhotoModel);
console.log("Video model:", resolvedVideoModel);

await supabase
  .from("orders")
  .update({
    status: "processing",
    price_rub: template.price_rub || 299,
    price_stars: template.price_stars || 1,
    updated_at: new Date().toISOString(),
  })
  .eq("id", order.id);
if (!order.bot_prepare_message_sent) {
  const prepareSent = await sendTelegramPreparingMessage(order);

  if (prepareSent) {
    await supabase
      .from("orders")
      .update({
        bot_prepare_message_sent: true,
        bot_prepare_message_sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", order.id);
  }
}
  let enhancedPhotoUrl = order.enhanced_photo_url;

  if (!enhancedPhotoUrl) {
    const photoUrls = getOrderPhotoUrls(order);

    if (photoUrls.length === 0) {
      throw new Error(`Order has no original photo URLs: ${order.id}`);
    }

    enhancedPhotoUrl = await createPhotoGeneration(
      resolvedPhotoModel,
      template.photo_prompt,
      photoUrls
    );
    console.log("Enhanced photo:", enhancedPhotoUrl);

    await supabase
      .from("orders")
      .update({
        enhanced_photo_url: enhancedPhotoUrl,
        status: "photo_ready",
        updated_at: new Date().toISOString(),
      })
      .eq("id", order.id);
  } else {
    console.log("Using existing enhanced photo:", enhancedPhotoUrl);
  }

  const videoUrl = await createVideoGeneration(
    resolvedVideoModel,
    template.video_prompt,
    enhancedPhotoUrl,
    videoDuration,
    videoResolution,
    videoAspectRatio,
    {
      imageMode: template.seedance_image_mode || "reference",
      videoParams: template.video_params,
      legacyMode: template.mode,
      legacyGenre: template.genre,
    }
  );
  console.log("Video ready:", videoUrl);

  await supabase
    .from("orders")
    .update({
      video_url: videoUrl,
      updated_at: new Date().toISOString(),
    })
    .eq("id", order.id);

  if (order.paid) {
    await supabase
      .from("orders")
      .update({
        video_url: videoUrl,
        status: "completed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", order.id);

    try {
      await sendTelegramVideo(order.telegram_user_id, videoUrl);

      await supabase
        .from("orders")
        .update({
          bot_message_sent: true,
          bot_message_sent_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", order.id);
    } catch (error) {
      console.error("Paid video delivery failed:", order.id, error.message);
    }

    console.log("Paid order delivered without preview:", order.id);
    return;
  }

  const { previewVideoUrl, previewImageUrl } = await createPreviewMedia(
    videoUrl,
    order.id,
    null
  );

  const previewUpdate = {
    video_url: videoUrl,
    status: "video_ready_locked",
    updated_at: new Date().toISOString(),
  };

  if (previewVideoUrl) {
    previewUpdate.preview_video_url = previewVideoUrl;
  }

  if (previewImageUrl) {
    previewUpdate.preview_image_url = previewImageUrl;
  }

  await supabase.from("orders").update(previewUpdate).eq("id", order.id);

  console.log("About to send Telegram preview:", {
    orderId: order.id,
    telegramUserId: order.telegram_user_id,
    hasBotToken: Boolean(process.env.BOT_TOKEN),
    previewVideoUrl,
    previewImageUrl,
  });

  const sent = await sendTelegramPreview(
    {
      ...order,
      preview_video_url: previewVideoUrl,
    },
    previewImageUrl,
    template
  );

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

async function refundCustomGenerationTokens(generation, reason) {
  const { data, error } = await supabase.rpc("refund_order_tokens", {
    p_order_id: generation.id,
    p_reason: String(reason || "custom_generation_failed").slice(0, 500),
  });

  if (error) {
    throw new Error(`Custom generation refund failed: ${error.message}`);
  }

  return Array.isArray(data) ? data[0] : data;
}

function buildGenjutsuPayload(generation) {
  const payload = {
    video_url: generation.video_url,
    resolution: generation.resolution,
  };
  const imageUrls = Array.isArray(generation.image_urls)
    ? generation.image_urls
    : [];

  if (imageUrls.length) {
    payload.image_urls = imageUrls;
  }

  if (generation.prompt) {
    payload.prompt = generation.prompt;
  }

  if (generation.model_key === "genjutsu_restyle") {
    payload.preset_id = generation.preset_id;
  }

  return payload;
}

async function processCustomGeneration(generation) {
  if (generation.status === "completed" && generation.result_url) {
    if (!generation.bot_message_sent) {
      await sendTelegramVideo(generation.telegram_user_id, generation.result_url);
      await supabase
        .from("custom_generations")
        .update({
          bot_message_sent: true,
          bot_message_sent_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", generation.id);
    }
    return;
  }

  const subscribed = await isUserSubscribedToChannel(
    generation.telegram_user_id
  );

  if (!subscribed) {
    await sendSubscriptionRequiredMessage(generation.telegram_user_id, "repeat");
    await refundCustomGenerationTokens(generation, "subscription_required");
    await supabase
      .from("custom_generations")
      .update({
        status: "subscription_required",
        error_message: "User is not subscribed to the channel",
        updated_at: new Date().toISOString(),
      })
      .eq("id", generation.id);
    return;
  }

  const now = new Date().toISOString();
  await supabase
    .from("custom_generations")
    .update({ status: "processing", updated_at: now })
    .eq("id", generation.id);

  if (!generation.bot_prepare_message_sent) {
    const sent = await sendTelegramPreparingMessage(generation);

    if (sent) {
      await supabase
        .from("custom_generations")
        .update({ bot_prepare_message_sent: true, updated_at: now })
        .eq("id", generation.id);
    }
  }

  let requestId = generation.provider_request_id;
  let statusUrl = generation.provider_status_url;

  if (!requestId) {
    const request = await createGeneration(
      generation.model_id,
      buildGenjutsuPayload(generation)
    );
    requestId = request.generationId;
    statusUrl = request.statusUrl;

    const { error } = await supabase
      .from("custom_generations")
      .update({
        provider_request_id: requestId,
        provider_status_url: statusUrl,
        updated_at: new Date().toISOString(),
      })
      .eq("id", generation.id);

    if (error) {
      throw new Error(`Failed to save Genjutsu request: ${error.message}`);
    }
  }

  const resultUrl = await pollGeneration(
    requestId,
    statusUrl,
    GENJUTSU_POLL_TIMEOUT_MS
  );
  const completedAt = new Date().toISOString();
  const { error: completeError } = await supabase
    .from("custom_generations")
    .update({
      status: "completed",
      result_url: resultUrl,
      error_message: null,
      completed_at: completedAt,
      updated_at: completedAt,
    })
    .eq("id", generation.id);

  if (completeError) {
    throw new Error(`Failed to save Genjutsu result: ${completeError.message}`);
  }

  try {
    await sendTelegramVideo(generation.telegram_user_id, resultUrl);
    await supabase
      .from("custom_generations")
      .update({
        bot_message_sent: true,
        bot_message_sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", generation.id);
  } catch (error) {
    console.error("Genjutsu delivery failed:", generation.id, error.message);
  }
}

async function checkCustomGenerations() {
  if (isCheckingCustomGenerations) {
    return;
  }

  isCheckingCustomGenerations = true;

  try {
    const { data, error } = await supabase
      .from("custom_generations")
      .select("*")
      .or(
        "status.in.(queued,processing),and(status.eq.completed,bot_message_sent.eq.false)"
      )
      .order("created_at", { ascending: true })
      .limit(1);

    if (error) {
      console.error("Custom generation queue error:", error.message);
      return;
    }

    for (const generation of data || []) {
      try {
        await processCustomGeneration(generation);
      } catch (error) {
        console.error("Custom generation failed:", generation.id, error.message);

        if (String(error.message || error).includes("polling timeout")) {
          await supabase
            .from("custom_generations")
            .update({
              status: "processing",
              error_message: "Generation is still processing",
              updated_at: new Date().toISOString(),
            })
            .eq("id", generation.id);
          continue;
        }

        if (generation.status !== "completed") {
          try {
            await refundCustomGenerationTokens(generation, error.message);
          } catch (refundError) {
            console.error("Custom generation refund failed:", refundError.message);
          }

          await sendTelegramErrorMessage(generation, error);
          await supabase
            .from("custom_generations")
            .update({
              status: "failed",
              error_message: String(error.message || error).slice(0, 2000),
              updated_at: new Date().toISOString(),
            })
            .eq("id", generation.id);
        }
      }
    }
  } finally {
    isCheckingCustomGenerations = false;
  }
}

async function checkOrders() {
  if (isCheckingOrders) {
    console.log("Order check skipped: previous check is still running");
    return;
  }

  isCheckingOrders = true;
  console.log("Checking orders...");

  try {
    const { data: orders, error } = await supabase
      .from("orders")
      .select("*")
      .or(
        "status.in.(photo_uploaded,photo_ready),and(status.eq.processing,provider_request_id.not.is.null),and(status.eq.video_ready_locked,bot_message_sent.is.false),and(status.eq.video_ready_locked,bot_message_sent.is.null),and(status.eq.completed,paid.eq.true,bot_message_sent.is.false),and(status.eq.completed,paid.eq.true,bot_message_sent.is.null)"
      )
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

        if (order.paid) {
          try {
            await refundOrderTokens(order, error.message);
          } catch (refundError) {
            console.error(
              "Order token refund failed:",
              order.id,
              refundError.message
            );
          }
        }

        const errorSent = await sendTelegramErrorMessage(order, error);

        await supabase
          .from("orders")
          .update({
            status: "failed",
            error_message: error.message,
            bot_error_message_sent: errorSent,
            bot_error_message_sent_at: errorSent
              ? new Date().toISOString()
              : null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", order.id);
      }
    }
  } finally {
    isCheckingOrders = false;
  }
}

function createHttpError(message, statusCode, apiCode = null, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.apiCode = apiCode;
  error.details = details;
  return error;
}

function getPublicMediaPrefix() {
  return `${String(process.env.SUPABASE_URL || "").replace(
    /\/$/,
    ""
  )}/storage/v1/object/public/media/`;
}

function normalizeUploadedMediaUrl(value, label, telegramUserId) {
  const normalized = String(value || "").trim();
  const expectedPrefix = `${getPublicMediaPrefix()}uploads/${encodeURIComponent(
    String(telegramUserId)
  )}/`;

  if (!normalized.startsWith(expectedPrefix)) {
    throw createHttpError(
      `${label} должен быть загружен через REDAKTOP`,
      400,
      "INVALID_MEDIA_URL"
    );
  }

  return normalized;
}

async function getRemoteContentLength(url) {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(15000),
    });
    const value = Number(response.headers.get("content-length"));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch (error) {
    console.warn("Media HEAD request failed:", error.message);
    return null;
  }
}

async function probeVideoUrl(url) {
  let stdout;

  try {
    stdout = await runCommand(ffprobePath, [
      "-v",
      "error",
      "-show_entries",
      "format=duration,size:stream=codec_type,width,height",
      "-of",
      "json",
      url,
    ]);
  } catch (error) {
    throw createHttpError(
      "Не удалось прочитать видео. Загрузите MP4, MOV или WEBM.",
      400,
      "INVALID_VIDEO"
    );
  }

  let data;

  try {
    data = JSON.parse(stdout);
  } catch (error) {
    throw createHttpError(
      "Не удалось определить параметры видео",
      400,
      "INVALID_VIDEO"
    );
  }

  const videoStream = (data.streams || []).find(
    (stream) => stream.codec_type === "video"
  );
  const duration = Number(data.format?.duration);
  const width = Number(videoStream?.width);
  const height = Number(videoStream?.height);
  const reportedSize = Number(data.format?.size);
  const remoteSize = await getRemoteContentLength(url);
  const size = Number.isFinite(reportedSize) && reportedSize > 0
    ? reportedSize
    : remoteSize;

  if (!videoStream || !Number.isFinite(duration) || duration < 4) {
    throw createHttpError(
      "Видео должно длиться не менее 4 секунд",
      400,
      "VIDEO_TOO_SHORT"
    );
  }

  if (size && size > GENJUTSU_MAX_VIDEO_BYTES) {
    throw createHttpError(
      "Размер видео не должен превышать 200 МБ",
      400,
      "VIDEO_TOO_LARGE"
    );
  }

  return { duration, width, height, size: size || null };
}

async function getUsdRubRate() {
  const now = Date.now();

  if (usdRubRateCache && usdRubRateCache.expiresAt > now) {
    return usdRubRateCache;
  }

  try {
    const response = await fetch("https://www.cbr.ru/scripts/XML_daily.asp", {
      headers: { "User-Agent": "REDAKTOP/1.0" },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(`CBR HTTP ${response.status}`);
    }

    const xml = await response.text();
    const usdBlock = (xml.match(/<Valute[^>]*>[\s\S]*?<\/Valute>/g) || [])
      .find((block) => block.includes("<CharCode>USD</CharCode>"));
    const nominal = Number(usdBlock?.match(/<Nominal>([^<]+)<\/Nominal>/)?.[1]);
    const value = Number(
      usdBlock?.match(/<Value>([^<]+)<\/Value>/)?.[1]?.replace(",", ".")
    );
    const rate = value / nominal;

    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error("USD rate is missing in CBR response");
    }

    usdRubRateCache = {
      rate: Number(rate.toFixed(4)),
      source: "cbr",
      expiresAt: now + 6 * 60 * 60 * 1000,
    };
    return usdRubRateCache;
  } catch (error) {
    const fallback = Number(process.env.USD_RUB_RATE);

    if (Number.isFinite(fallback) && fallback > 0) {
      console.warn("CBR rate unavailable, using USD_RUB_RATE:", error.message);
      usdRubRateCache = {
        rate: Number(fallback.toFixed(4)),
        source: "environment_fallback",
        expiresAt: now + 15 * 60 * 1000,
      };
      return usdRubRateCache;
    }

    throw createHttpError(
      "Не удалось получить курс валют. Попробуйте немного позже.",
      503,
      "EXCHANGE_RATE_UNAVAILABLE"
    );
  }
}

function sanitizeGenjutsuPresets(result) {
  const items = Array.isArray(result?.items)
    ? result.items
    : Array.isArray(result?.data?.items)
      ? result.data.items
      : [];

  return items
    .filter((item) => item?.id && item?.name)
    .map((item) => ({
      id: String(item.id),
      name: String(item.name),
      preview_url: item.preview_url ? String(item.preview_url) : null,
    }));
}

async function getGenjutsuPresets() {
  const now = Date.now();

  if (genjutsuPresetCache && genjutsuPresetCache.expiresAt > now) {
    return genjutsuPresetCache.items;
  }

  const result = await higgsfieldRequest(
    "/models/higgsfield/genjutsu/restyle/v1.0/presets"
  );
  const items = sanitizeGenjutsuPresets(result);

  if (!items.length) {
    throw new Error("Higgsfield did not return Genjutsu Restyle presets");
  }

  genjutsuPresetCache = {
    items,
    expiresAt: now + 60 * 60 * 1000,
  };
  return items;
}

function verifyTelegramInitData(initData) {
  if (typeof initData !== "string" || !initData) {
    throw createHttpError("Missing Telegram init data", 401);
  }

  const botToken = process.env.BOT_TOKEN;

  if (!botToken) {
    throw new Error("Missing BOT_TOKEN");
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");

  if (!receivedHash) {
    throw createHttpError("Invalid Telegram init data", 401);
  }

  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();
  const expectedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (!timingSafeSignatureEqual(receivedHash, expectedHash)) {
    throw createHttpError("Invalid Telegram init data signature", 401);
  }

  const authDate = Number(params.get("auth_date"));
  const nowSeconds = Math.floor(Date.now() / 1000);

  if (
    !Number.isFinite(authDate) ||
    authDate > nowSeconds + 60 ||
    nowSeconds - authDate > TELEGRAM_INIT_DATA_MAX_AGE_SECONDS
  ) {
    throw createHttpError("Telegram session expired", 401);
  }

  let user;

  try {
    user = JSON.parse(params.get("user") || "null");
  } catch (error) {
    throw createHttpError("Invalid Telegram user data", 401);
  }

  if (!user?.id) {
    throw createHttpError("Telegram user is missing", 401);
  }

  return user;
}

function getBotToken() {
  const botToken = process.env.BOT_TOKEN;

  if (!botToken) {
    throw new Error("Missing BOT_TOKEN");
  }

  return botToken;
}

function verifyTelegramLoginPayload(payload) {
  const receivedHash = String(payload?.hash || "").trim();

  if (!receivedHash) {
    throw createHttpError("Некорректные данные входа Telegram", 401, "INVALID_TELEGRAM_LOGIN");
  }

  const dataCheckString = Object.entries(payload || {})
    .filter(([key, value]) => key !== "hash" && value !== undefined && value !== null)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = crypto.createHash("sha256").update(getBotToken()).digest();
  const expectedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (!timingSafeSignatureEqual(receivedHash, expectedHash)) {
    throw createHttpError("Подпись Telegram не прошла проверку", 401, "INVALID_TELEGRAM_LOGIN");
  }

  const authDate = Number(payload.auth_date);
  const nowSeconds = Math.floor(Date.now() / 1000);

  if (
    !Number.isFinite(authDate) ||
    authDate > nowSeconds + 60 ||
    nowSeconds - authDate > TELEGRAM_INIT_DATA_MAX_AGE_SECONDS
  ) {
    throw createHttpError("Вход Telegram устарел. Войдите ещё раз", 401, "TELEGRAM_LOGIN_EXPIRED");
  }

  if (!payload.id) {
    throw createHttpError("Telegram не передал пользователя", 401, "INVALID_TELEGRAM_LOGIN");
  }

  return {
    id: String(payload.id),
    username: payload.username ? String(payload.username) : undefined,
    first_name: payload.first_name ? String(payload.first_name) : undefined,
    last_name: payload.last_name ? String(payload.last_name) : undefined,
    photo_url: payload.photo_url ? String(payload.photo_url) : undefined,
  };
}

function createWebSessionToken(telegramUser) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      iat: nowSeconds,
      exp: nowSeconds + WEB_SESSION_MAX_AGE_SECONDS,
      user: {
        id: String(telegramUser.id),
        username: telegramUser.username || null,
        first_name: telegramUser.first_name || null,
        last_name: telegramUser.last_name || null,
      },
    })
  ).toString("base64url");
  const signature = crypto
    .createHmac("sha256", getBotToken())
    .update(payload)
    .digest("base64url");

  return `${payload}.${signature}`;
}

function verifyWebSessionToken(token) {
  const [payload, receivedSignature, extra] = String(token || "").split(".");

  if (!payload || !receivedSignature || extra) {
    throw createHttpError("Войдите через Telegram", 401, "WEB_SESSION_INVALID");
  }

  const expectedSignature = crypto
    .createHmac("sha256", getBotToken())
    .update(payload)
    .digest("base64url");

  if (!timingSafeTextEqual(receivedSignature, expectedSignature)) {
    throw createHttpError("Сессия браузера недействительна", 401, "WEB_SESSION_INVALID");
  }

  let decoded;

  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch (error) {
    throw createHttpError("Сессия браузера повреждена", 401, "WEB_SESSION_INVALID");
  }

  if (!decoded?.user?.id || Number(decoded.exp) <= Math.floor(Date.now() / 1000)) {
    throw createHttpError("Сессия браузера истекла. Войдите снова", 401, "WEB_SESSION_EXPIRED");
  }

  return decoded.user;
}

function getBearerToken(req) {
  const authorization = String(req.headers.authorization || "");
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

function resolvePlatformTelegramUser(req, body = {}) {
  if (body.init_data) {
    return verifyTelegramInitData(body.init_data);
  }

  return verifyWebSessionToken(getBearerToken(req));
}

function createHistoryDownloadToken(telegramUserId, kind, itemId) {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      exp: Math.floor(Date.now() / 1000) + HISTORY_DOWNLOAD_MAX_AGE_SECONDS,
      user_id: String(telegramUserId),
      kind: kind === "custom" ? "custom" : "template",
      item_id: String(itemId),
    })
  ).toString("base64url");
  const signature = crypto
    .createHmac("sha256", getBotToken())
    .update(`history-download:${payload}`)
    .digest("base64url");

  return `${payload}.${signature}`;
}

function verifyHistoryDownloadToken(token) {
  const [payload, receivedSignature, extra] = String(token || "").split(".");

  if (!payload || !receivedSignature || extra) {
    throw createHttpError("Ссылка для скачивания недействительна", 401);
  }

  const expectedSignature = crypto
    .createHmac("sha256", getBotToken())
    .update(`history-download:${payload}`)
    .digest("base64url");

  if (!timingSafeTextEqual(receivedSignature, expectedSignature)) {
    throw createHttpError("Ссылка для скачивания недействительна", 401);
  }

  let decoded;

  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch (error) {
    throw createHttpError("Ссылка для скачивания повреждена", 401);
  }

  if (
    !decoded?.user_id ||
    !decoded?.item_id ||
    Number(decoded.exp) <= Math.floor(Date.now() / 1000)
  ) {
    throw createHttpError("Ссылка для скачивания истекла", 401);
  }

  return decoded;
}

async function upsertPlatformUser(telegramUser) {
  const telegramUserId = String(telegramUser.id);
  const { data: user, error } = await supabase
    .from("app_users")
    .upsert(
      {
        telegram_user_id: telegramUserId,
        username: telegramUser.username || null,
        first_name: telegramUser.first_name || null,
        last_name: telegramUser.last_name || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "telegram_user_id" }
    )
    .select("id, telegram_user_id, username, first_name, last_name, balance_tokens")
    .single();

  if (error || !user) {
    throw new Error(`Platform user upsert failed: ${error?.message || "unknown"}`);
  }

  return user;
}

function getPublicTokenPackages() {
  return Object.values(TOKEN_PACKAGES).map((tokenPackage) => ({
    id: tokenPackage.id,
    tokens: tokenPackage.tokens,
    price_rub: tokenPackage.priceRub,
  }));
}

async function createTokenCheckout(telegramUser, packageId, legalAccepted) {
  if (legalAccepted !== true) {
    throw createHttpError(
      "Подтвердите согласие с политикой конфиденциальности и публичной офертой",
      400
    );
  }

  const tokenPackage = TOKEN_PACKAGES[packageId];

  if (!tokenPackage) {
    throw createHttpError(`Unknown token package: ${packageId}`, 400);
  }

  const user = await upsertPlatformUser(telegramUser);
  const { data: payment, error: paymentError } = await supabase
    .from("token_payments")
    .insert({
      user_id: user.id,
      telegram_user_id: user.telegram_user_id,
      package_id: tokenPackage.id,
      tokens: tokenPackage.tokens,
      amount_rub: tokenPackage.priceRub,
      status: "pending",
      privacy_accepted_at: new Date().toISOString(),
      offer_accepted_at: new Date().toISOString(),
    })
    .select("id, amount_rub, tokens, robokassa_inv_id")
    .single();

  if (paymentError || !payment) {
    throw new Error(
      `Token payment creation failed: ${paymentError?.message || "unknown"}`
    );
  }

  const checkout = createRobokassaTokenPaymentUrl(payment);
  const { error: updateError } = await supabase
    .from("token_payments")
    .update({
      robokassa_inv_id: checkout.invId,
      payment_url: checkout.paymentUrl,
      updated_at: new Date().toISOString(),
    })
    .eq("id", payment.id);

  if (updateError) {
    throw new Error(`Token payment update failed: ${updateError.message}`);
  }

  return {
    payment_id: payment.id,
    payment_url: checkout.paymentUrl,
    tokens: tokenPackage.tokens,
    amount_rub: tokenPackage.priceRub,
  };
}

function getRobokassaParam(params, names) {
  for (const name of names) {
    const value = params.get(name);

    if (value !== null && value !== undefined && value !== "") {
      return value;
    }
  }

  return null;
}

function timingSafeSignatureEqual(left, right) {
  if (!left || !right) {
    return false;
  }

  const leftBuffer = Buffer.from(String(left).toLowerCase(), "utf8");
  const rightBuffer = Buffer.from(String(right).toLowerCase(), "utf8");

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function timingSafeTextEqual(left, right) {
  if (!left || !right) {
    return false;
  }

  const leftBuffer = Buffer.from(String(left), "utf8");
  const rightBuffer = Buffer.from(String(right), "utf8");

  return leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function collectRobokassaShpParams(params) {
  const shpParams = {};

  for (const [key, value] of params.entries()) {
    if (key.toLowerCase().startsWith("shp_")) {
      shpParams[key] = value;
    }
  }

  return shpParams;
}

function assertRobokassaSignature(params) {
  const { password2, hashAlgorithm } = getRobokassaConfig();
  const outSum = getRobokassaParam(params, ["OutSum", "out_sum"]);
  const invId = getRobokassaParam(params, ["InvId", "InvID", "InvoiceID"]);
  const signatureValue = getRobokassaParam(params, [
    "SignatureValue",
    "signatureValue",
    "signature",
  ]);

  if (!outSum || !invId || !signatureValue) {
    const error = new Error("Missing Robokassa result params");
    error.statusCode = 400;
    throw error;
  }

  const shpTail = getShpSignatureTail(collectRobokassaShpParams(params));
  const signatureBase = `${outSum}:${invId}:${password2}${
    shpTail ? `:${shpTail}` : ""
  }`;
  const expectedSignature = robokassaHashHex(
    signatureBase,
    hashAlgorithm
  );

  if (!timingSafeSignatureEqual(signatureValue, expectedSignature)) {
    const error = new Error("Invalid Robokassa signature");
    error.statusCode = 400;
    throw error;
  }

  return { outSum, invId };
}

function assertRobokassaAmount(outSum, order) {
  const paidAmount = Number(outSum);
  const expectedAmount = Number(formatRobokassaOutSum(order.price_rub));

  if (
    !Number.isFinite(paidAmount) ||
    Math.abs(paidAmount - expectedAmount) > 0.01
  ) {
    const error = new Error(
      `Robokassa amount mismatch for order ${order.id}: ${outSum}`
    );
    error.statusCode = 400;
    throw error;
  }
}

function assertRobokassaTokenAmount(outSum, payment) {
  const paidAmount = Number(outSum);
  const expectedAmount = Number(formatRobokassaOutSum(payment.amount_rub));

  if (
    !Number.isFinite(paidAmount) ||
    Math.abs(paidAmount - expectedAmount) > 0.01
  ) {
    const error = new Error(
      `Robokassa amount mismatch for token payment ${payment.id}: ${outSum}`
    );
    error.statusCode = 400;
    throw error;
  }
}

function getRobokassaProviderPayload(params) {
  const payload = {};

  for (const [key, value] of params.entries()) {
    if (key.toLowerCase() === "signaturevalue") {
      continue;
    }

    payload[key] = value;
  }

  return payload;
}

async function handleRobokassaTokenResult(params, outSum, invId) {
  const paymentId = getRobokassaParam(params, [
    "Shp_paymentId",
    "Shp_payment_id",
  ]);

  if (!paymentId) {
    throw createHttpError("Missing Robokassa token payment id", 400);
  }

  const { data: payment, error } = await supabase
    .from("token_payments")
    .select(
      "id, user_id, telegram_user_id, status, tokens, amount_rub, robokassa_inv_id"
    )
    .eq("id", paymentId)
    .single();

  if (error || !payment) {
    throw createHttpError(
      `Robokassa token payment not found: ${paymentId}`,
      404
    );
  }

  if (String(payment.robokassa_inv_id) !== String(invId)) {
    throw createHttpError(
      `Robokassa invoice mismatch for token payment ${payment.id}`,
      400
    );
  }

  assertRobokassaTokenAmount(outSum, payment);

  const { data: completionRows, error: completionError } = await supabase.rpc(
    "complete_token_payment",
    {
      p_payment_id: payment.id,
      p_inv_id: String(invId),
      p_provider_payload: getRobokassaProviderPayload(params),
    }
  );

  if (completionError) {
    throw new Error(
      `Token balance update failed: ${completionError.message}`
    );
  }

  const completion = Array.isArray(completionRows)
    ? completionRows[0]
    : completionRows;

  if (!completion?.already_processed) {
    try {
      await sendTelegramMessage(
        payment.telegram_user_id,
        `✅ Баланс Redaktop ai пополнен на ${payment.tokens} токенов.\n\nТекущий баланс: ${completion?.new_balance || 0} токенов.`
      );
    } catch (notificationError) {
      console.error(
        "Token payment notification failed:",
        notificationError.message
      );
    }
  }

  console.log("Robokassa token payment processed:", {
    paymentId: payment.id,
    tokens: payment.tokens,
    invId,
    alreadyProcessed: Boolean(completion?.already_processed),
  });

  return invId;
}

async function handleRobokassaResult(params) {
  const { outSum, invId } = assertRobokassaSignature(params);
  const paymentType = getRobokassaParam(params, [
    "Shp_paymentType",
    "Shp_payment_type",
  ]);

  if (paymentType === "tokens") {
    return handleRobokassaTokenResult(params, outSum, invId);
  }

  const orderId = getRobokassaParam(params, ["Shp_orderId", "Shp_order_id"]);

  if (!orderId) {
    const error = new Error("Missing Robokassa order id");
    error.statusCode = 400;
    throw error;
  }

  const { data: order, error } = await supabase
    .from("orders")
    .select("id, paid, video_url, telegram_user_id, price_rub")
    .eq("id", orderId)
    .single();

  if (error || !order) {
    const notFoundError = new Error(`Robokassa order not found: ${orderId}`);
    notFoundError.statusCode = 404;
    throw notFoundError;
  }

  assertRobokassaAmount(outSum, order);

  if (!order.video_url) {
    throw new Error(`Paid Robokassa order has no video_url: ${order.id}`);
  }

  if (order.paid) {
    console.log("Robokassa duplicate callback ignored:", {
      orderId: order.id,
      invId,
    });

    return invId;
  }

  const now = new Date().toISOString();
  const { error: updateError } = await supabase
    .from("orders")
    .update({
      paid: true,
      payment_method: "robokassa",
      paid_at: now,
      updated_at: now,
    })
    .eq("id", order.id);

  if (updateError) {
    throw new Error(`Robokassa order update failed: ${updateError.message}`);
  }

  await sendTelegramVideo(order.telegram_user_id, order.video_url);

  console.log("Robokassa payment processed:", {
    orderId: order.id,
    invId,
    outSum,
  });

  return invId;
}

async function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;

      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });

    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function parseRequestParams(req, body) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const params = new URLSearchParams(requestUrl.search);
  const contentType = req.headers["content-type"] || "";

  if (!body) {
    return params;
  }

  if (contentType.includes("application/json")) {
    const parsed = JSON.parse(body);

    for (const [key, value] of Object.entries(parsed)) {
      params.set(key, String(value));
    }

    return params;
  }

  const bodyParams = new URLSearchParams(body);

  for (const [key, value] of bodyParams.entries()) {
    params.set(key, value);
  }

  return params;
}

function getAllowedFrontendOrigins() {
  const configuredOrigins = String(
    process.env.FRONTEND_ORIGINS || "https://tg-miniapp-liart.vercel.app"
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return new Set(configuredOrigins);
}

function isAllowedFrontendOrigin(origin) {
  if (!origin) {
    return true;
  }

  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return true;
  }

  return getAllowedFrontendOrigins().has(origin);
}

function applyCorsHeaders(req, res) {
  const origin = req.headers.origin;

  if (origin && isAllowedFrontendOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function sendJsonResponse(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJsonRequest(req) {
  const body = await readRequestBody(req);

  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch (error) {
    throw createHttpError("Invalid JSON body", 400);
  }
}

function sanitizeTemplateForCatalog(template) {
  const allowedKeys = [
    "slug",
    "title",
    "name",
    "description",
    "cover_url",
    "preview_url",
    "thumbnail_url",
    "image_url",
    "reference_url",
    "preview_video_url",
    "source_video_url",
    "photo_model",
    "video_model",
    "aspect_ratio",
    "duration",
    "resolution",
    "price_rub",
    "required_photo_count",
    "photo_rules",
    "available_resolutions",
  ];
  const publicTemplate = {};

  for (const key of allowedKeys) {
    if (template[key] !== undefined && template[key] !== null) {
      publicTemplate[key] = template[key];
    }
  }

  return publicTemplate;
}

async function getPlatformCatalog() {
  const { data: templates, error } = await supabase
    .from("templates")
    .select("*")
    .eq("is_active", true)
    .order("slug", { ascending: true });

  if (error) {
    throw new Error(`Template catalog failed: ${error.message}`);
  }

  const genjutsuPriceRubPerSecond = Object.fromEntries(
    Object.entries(GENJUTSU_RATES_USD).map(([resolution, rate]) => [
      resolution,
      rate * GENJUTSU_USD_RUB_RATE * GENJUTSU_RETAIL_MULTIPLIER,
    ])
  );
  const publicTemplates = (templates || []).map((template) => {
    const publicTemplate = sanitizeTemplateForCatalog(template);

    if (template.generation_mode === "genjutsu_motion_template") {
      publicTemplate.resolution = "480p";
      publicTemplate.price_rub = getTemplateTokenPrice(template, "480p");
    }

    return publicTemplate;
  });

  return {
    templates: publicTemplates,
    token_packages: getPublicTokenPackages(),
    pricing: {
      currency: "RUB",
      token_value_rub: TOKEN_VALUE_RUB,
      rounding: "ceil_to_token",
      genjutsu: {
        price_rub_per_second: genjutsuPriceRubPerSecond,
        duration_rounding: "ceil_after_trim_to_30_seconds",
      },
    },
  };
}

async function getPlatformAccount(telegramUser) {
  const user = await upsertPlatformUser(telegramUser);

  return {
    user: {
      id: user.id,
      telegram_user_id: user.telegram_user_id,
      username: user.username,
      first_name: user.first_name,
      last_name: user.last_name,
    },
    balance_tokens: Number(user.balance_tokens || 0),
  };
}

function getTemplateTokenPrice(template, resolution = "480p") {
  const basePrice = Math.ceil(Number(template?.price_rub));
  const baseResolution = String(template?.resolution || "480p");

  if (
    String(resolution) === baseResolution &&
    Number.isFinite(basePrice) &&
    basePrice > 0
  ) {
    return basePrice;
  }

  if (template?.generation_mode === "genjutsu_motion_template") {
    return calculateGenjutsuPricing(template.duration, resolution).priceTokens;
  }

  const priceTokens = basePrice;

  if (!Number.isFinite(priceTokens) || priceTokens <= 0) {
    throw createHttpError(
      `Для шаблона ${template?.slug || "unknown"} не настроена стоимость`,
      500,
      "TEMPLATE_PRICE_MISSING"
    );
  }

  return priceTokens;
}

function normalizeUploadedPhotoUrls(photoUrls) {
  const urls = Array.isArray(photoUrls) ? photoUrls : [];
  const publicMediaPrefix = `${String(process.env.SUPABASE_URL || "").replace(
    /\/$/,
    ""
  )}/storage/v1/object/public/media/`;

  if (urls.length < 1 || urls.length > 10) {
    throw createHttpError("Добавьте от 1 до 10 фотографий", 400, "INVALID_PHOTOS");
  }

  const normalizedUrls = urls.map((value) => String(value || "").trim());
  const invalidUrl = normalizedUrls.find(
    (value) => !value.startsWith(publicMediaPrefix)
  );

  if (invalidUrl) {
    throw createHttpError(
      "Фотографии должны быть загружены через REDAKTOP",
      400,
      "INVALID_PHOTO_URL"
    );
  }

  return normalizedUrls;
}

async function createPaidPlatformOrder(
  telegramUser,
  templateSlug,
  photoUrls,
  requestedResolution,
  requestedTemplateOptions
) {
  const user = await upsertPlatformUser(telegramUser);
  const normalizedPhotoUrls = normalizeUploadedPhotoUrls(photoUrls);
  const normalizedSlug = String(templateSlug || "").trim();
  const { data: template, error: templateError } = await supabase
    .from("templates")
    .select("*")
    .eq("slug", normalizedSlug)
    .single();

  if (templateError || !template) {
    throw createHttpError("Шаблон не найден", 404, "TEMPLATE_NOT_FOUND");
  }

  if (template.is_active === false) {
    throw createHttpError("Шаблон больше недоступен", 404, "TEMPLATE_NOT_FOUND");
  }

  const requiredPhotoCount = Math.max(
    1,
    Number(template.required_photo_count || 1)
  );

  if (normalizedPhotoUrls.length !== requiredPhotoCount) {
    throw createHttpError(
      `Для этого шаблона нужно ровно ${requiredPhotoCount} фото`,
      400,
      "INVALID_PHOTO_COUNT"
    );
  }

  const availableResolutions = Array.isArray(template.available_resolutions)
    ? template.available_resolutions.map(String)
    : [String(template.resolution || "480p")];
  const selectedResolution = String(
    requestedResolution || "480p"
  ).trim();

  if (!availableResolutions.includes(selectedResolution)) {
    throw createHttpError(
      "Выберите доступное качество видео",
      400,
      "INVALID_RESOLUTION"
    );
  }

  const priceTokens = getTemplateTokenPrice(template, selectedResolution);
  const templateOptions =
    template.slug === "rap_in_car"
      ? { rapper_outfit: requestedTemplateOptions?.rapper_outfit === true }
      : {};
  const currentBalance = Number(user.balance_tokens || 0);

  if (currentBalance < priceTokens) {
    throw createHttpError(
      `Недостаточно токенов: нужно ${priceTokens}, на балансе ${currentBalance}`,
      402,
      "INSUFFICIENT_BALANCE",
      { balance_tokens: currentBalance, required_tokens: priceTokens }
    );
  }

  const orderId = crypto.randomUUID();
  const now = new Date().toISOString();
  const { error: draftError } = await supabase.from("orders").insert({
    id: orderId,
    telegram_user_id: user.telegram_user_id,
    template_slug: template.slug,
    original_photo_url: normalizedPhotoUrls[0],
    original_photo_urls: normalizedPhotoUrls,
    selected_resolution: selectedResolution,
    template_options: templateOptions,
    status: "failed",
    paid: false,
    price_rub: priceTokens,
    error_message: "Awaiting token reservation",
    updated_at: now,
  });

  if (draftError) {
    throw new Error(`Order draft creation failed: ${draftError.message}`);
  }

  const { data: reservationData, error: reservationError } = await supabase.rpc(
    "reserve_order_tokens",
    {
      p_user_id: user.id,
      p_order_id: orderId,
      p_template_slug: template.slug,
      p_tokens: priceTokens,
    }
  );

  if (reservationError) {
    await supabase.from("orders").delete().eq("id", orderId);

    if (/insufficient token balance/i.test(reservationError.message || "")) {
      throw createHttpError(
        "Недостаточно токенов для создания",
        402,
        "INSUFFICIENT_BALANCE",
        { balance_tokens: currentBalance, required_tokens: priceTokens }
      );
    }

    throw new Error(`Token reservation failed: ${reservationError.message}`);
  }

  const newBalance = Number(reservationData);
  const { error: activateError } = await supabase
    .from("orders")
    .update({
      status: "photo_uploaded",
      paid: true,
      paid_at: now,
      error_message: null,
      updated_at: now,
    })
    .eq("id", orderId);

  if (activateError) {
    await supabase.rpc("refund_order_tokens", {
      p_order_id: orderId,
      p_reason: "order_activation_failed",
    });
    throw new Error(`Order activation failed: ${activateError.message}`);
  }

  return {
    order_id: orderId,
    status: "photo_uploaded",
    charged_tokens: priceTokens,
    balance_tokens: newBalance,
  };
}

async function normalizeGenjutsuImageUrls(imageUrls, model, telegramUserId) {
  const urls = Array.isArray(imageUrls) ? imageUrls : [];

  if (urls.length < model.minImages || urls.length > model.maxImages) {
    const expected = model.minImages === 0
      ? `не более ${model.maxImages}`
      : `от ${model.minImages} до ${model.maxImages}`;
    throw createHttpError(
      `Добавьте ${expected} изображений`,
      400,
      "INVALID_IMAGE_COUNT"
    );
  }

  const normalized = urls.map((url) =>
    normalizeUploadedMediaUrl(url, "Изображение", telegramUserId)
  );
  const sizes = await Promise.all(normalized.map(getRemoteContentLength));

  if (sizes.some((size) => size && size > GENJUTSU_MAX_IMAGE_BYTES)) {
    throw createHttpError(
      "Размер каждого изображения не должен превышать 64 МБ",
      400,
      "IMAGE_TOO_LARGE"
    );
  }

  return normalized;
}

async function createPaidCustomGeneration(telegramUser, input) {
  const user = await upsertPlatformUser(telegramUser);
  const modelKey = String(input?.model_key || "").trim();
  const model = GENJUTSU_MODELS[modelKey];

  if (!model) {
    throw createHttpError(
      "Эта модель пока не поддерживается",
      400,
      "UNSUPPORTED_MODEL"
    );
  }

  const resolution = String(input?.resolution || "720p").trim();

  if (!GENJUTSU_RATES_USD[resolution]) {
    throw createHttpError(
      "Выберите разрешение 480p, 720p или 1080p",
      400,
      "INVALID_RESOLUTION"
    );
  }

  const prompt = String(input?.prompt || "").trim();

  if (prompt.length > 10000) {
    throw createHttpError(
      "Промпт не должен превышать 10 000 символов",
      400,
      "PROMPT_TOO_LONG"
    );
  }

  const videoUrl = normalizeUploadedMediaUrl(
    input?.video_url,
    "Видео",
    user.telegram_user_id
  );
  const imageUrls = await normalizeGenjutsuImageUrls(
    input?.image_urls,
    model,
    user.telegram_user_id
  );
  const video = await probeVideoUrl(videoUrl);

  if (
    model.minimumPixels &&
    (!video.width || !video.height || video.width * video.height < model.minimumPixels)
  ) {
    throw createHttpError(
      "Для Object Swap видео должно иметь не менее 409 600 пикселей в кадре",
      400,
      "VIDEO_RESOLUTION_TOO_LOW"
    );
  }

  let presetId = null;

  if (model.requiresPreset) {
    presetId = String(input?.preset_id || "").trim();
    const presets = await getGenjutsuPresets();

    if (!presets.some((preset) => preset.id === presetId)) {
      throw createHttpError(
        "Выберите доступный стиль Restyle",
        400,
        "INVALID_PRESET"
      );
    }
  }

  const pricing = calculateGenjutsuPricing(video.duration, resolution);
  const billedSeconds = pricing.billedSeconds;
  const currentBalance = Number(user.balance_tokens || 0);

  if (currentBalance < pricing.priceTokens) {
    throw createHttpError(
      `Недостаточно токенов: нужно ${pricing.priceTokens}, на балансе ${currentBalance}`,
      402,
      "INSUFFICIENT_BALANCE",
      {
        balance_tokens: currentBalance,
        required_tokens: pricing.priceTokens,
      }
    );
  }

  const generationId = crypto.randomUUID();
  const now = new Date().toISOString();
  const { error: draftError } = await supabase.from("custom_generations").insert({
    id: generationId,
    user_id: user.id,
    telegram_user_id: user.telegram_user_id,
    model_key: modelKey,
    model_id: model.modelId,
    status: "failed",
    prompt: prompt || null,
    video_url: videoUrl,
    image_urls: imageUrls,
    resolution,
    preset_id: presetId,
    source_duration_seconds: Number(video.duration.toFixed(3)),
    source_width: video.width || null,
    source_height: video.height || null,
    source_size_bytes: video.size,
    billed_seconds: billedSeconds,
    provider_cost_usd: pricing.providerCostUsd,
    usd_rub_rate: pricing.usdRubRate,
    markup_multiplier: GENJUTSU_RETAIL_MULTIPLIER,
    retail_price_rub: pricing.retailPriceRub,
    charged_tokens: pricing.priceTokens,
    error_message: "Awaiting token reservation",
    updated_at: now,
  });

  if (draftError) {
    throw new Error(`Custom generation draft failed: ${draftError.message}`);
  }

  const { data: reservationData, error: reservationError } = await supabase.rpc(
    "reserve_order_tokens",
    {
      p_user_id: user.id,
      p_order_id: generationId,
      p_template_slug: `custom:${modelKey}`,
      p_tokens: pricing.priceTokens,
    }
  );

  if (reservationError) {
    await supabase.from("custom_generations").delete().eq("id", generationId);

    if (/insufficient token balance/i.test(reservationError.message || "")) {
      throw createHttpError(
        "Недостаточно токенов для создания",
        402,
        "INSUFFICIENT_BALANCE",
        {
          balance_tokens: currentBalance,
          required_tokens: pricing.priceTokens,
        }
      );
    }

    throw new Error(`Custom token reservation failed: ${reservationError.message}`);
  }

  const { error: activateError } = await supabase
    .from("custom_generations")
    .update({ status: "queued", error_message: null, updated_at: now })
    .eq("id", generationId);

  if (activateError) {
    await supabase.rpc("refund_order_tokens", {
      p_order_id: generationId,
      p_reason: "custom_generation_activation_failed",
    });
    throw new Error(`Custom generation activation failed: ${activateError.message}`);
  }

  return {
    generation_id: generationId,
    status: "queued",
    charged_tokens: pricing.priceTokens,
    retail_price_rub: pricing.retailPriceRub,
    billed_seconds: billedSeconds,
    balance_tokens: Number(reservationData),
  };
}

async function getPlatformHistory(telegramUser) {
  const telegramUserId = String(telegramUser.id);
  const [ordersResult, customResult] = await Promise.all([
    supabase
      .from("orders")
      .select(
        "id, created_at, template_slug, status, paid, price_rub, original_photo_url, preview_image_url, preview_video_url, video_url"
      )
      .eq("telegram_user_id", telegramUserId)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("custom_generations")
      .select(
        "id, created_at, model_key, status, charged_tokens, image_urls, video_url, result_url"
      )
      .eq("telegram_user_id", telegramUserId)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  if (ordersResult.error) {
    throw new Error(`Platform history failed: ${ordersResult.error.message}`);
  }

  if (customResult.error) {
    throw new Error(`Custom history failed: ${customResult.error.message}`);
  }

  const templateSlugs = [...new Set(
    (ordersResult.data || []).map((order) => order.template_slug).filter(Boolean)
  )];
  let templateTitles = new Map();

  if (templateSlugs.length) {
    const templatesResult = await supabase
      .from("templates")
      .select("slug, title")
      .in("slug", templateSlugs);

    if (templatesResult.error) {
      console.warn("History template titles failed:", templatesResult.error.message);
    } else {
      templateTitles = new Map(
        (templatesResult.data || []).map((template) => [
          template.slug,
          template.title,
        ])
      );
    }
  }

  const orders = (ordersResult.data || []).map((order) => ({
    ...order,
    kind: "template",
    title:
      templateTitles.get(order.template_slug) ||
      (order.template_slug === "dance_with_dog"
        ? "Танец с собачкой"
        : "Видео по шаблону"),
    video_url: order.paid ? order.video_url : null,
  }));
  const customGenerations = (customResult.data || []).map((generation) => ({
    id: generation.id,
    kind: "custom",
    created_at: generation.created_at,
    template_slug:
      GENJUTSU_MODELS[generation.model_key]?.label || generation.model_key,
    title: "Видео, созданное с нуля",
    status: generation.status,
    paid: true,
    price_rub: generation.charged_tokens,
    original_photo_url: Array.isArray(generation.image_urls)
      ? generation.image_urls[0] || null
      : null,
    preview_image_url: null,
    preview_video_url: null,
    video_url: generation.result_url || null,
  }));

  return [...orders, ...customGenerations]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 50);
}

async function getOwnedHistoryVideo(userId, kind, itemId) {
  const table = kind === "custom" ? "custom_generations" : "orders";
  const videoColumn = kind === "custom" ? "result_url" : "video_url";
  const { data, error } = await supabase
    .from(table)
    .select(`id, status, telegram_user_id, ${videoColumn}`)
    .eq("id", String(itemId))
    .eq("telegram_user_id", String(userId))
    .maybeSingle();

  if (error) {
    throw new Error(`History video lookup failed: ${error.message}`);
  }

  const videoUrl = data?.[videoColumn];

  if (!data || data.status !== "completed" || !videoUrl) {
    throw createHttpError("Готовое видео не найдено", 404, "VIDEO_NOT_READY");
  }

  return String(videoUrl);
}

function publicRequestBaseUrl(req) {
  const protocol = String(req.headers["x-forwarded-proto"] || "https")
    .split(",")[0]
    .trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "");
  return `${protocol}://${host}`;
}

async function streamHistoryVideo(req, res, downloadToken) {
  const payload = verifyHistoryDownloadToken(downloadToken);
  const videoUrl = await getOwnedHistoryVideo(
    payload.user_id,
    payload.kind,
    payload.item_id
  );
  const upstream = await fetch(videoUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(120000),
  });

  if (!upstream.ok || !upstream.body) {
    throw createHttpError("Не удалось скачать видео", 502, "VIDEO_DOWNLOAD_FAILED");
  }

  res.statusCode = 200;
  res.setHeader(
    "Content-Type",
    upstream.headers.get("content-type") || "video/mp4"
  );
  const contentLength = upstream.headers.get("content-length");
  if (contentLength) res.setHeader("Content-Length", contentLength);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="redaktop-${payload.item_id}.mp4"`
  );

  await new Promise((resolve, reject) => {
    const stream = Readable.fromWeb(upstream.body);
    stream.on("error", reject);
    res.on("error", reject);
    res.on("finish", resolve);
    stream.pipe(res);
  });
}

async function handlePlatformApiRequest(req, res, requestUrl) {
  if (!requestUrl.pathname.startsWith("/api/")) {
    return false;
  }

  applyCorsHeaders(req, res);

  if (!isAllowedFrontendOrigin(req.headers.origin)) {
    sendJsonResponse(res, 403, { error: "Origin is not allowed" });
    return true;
  }

  if (req.method === "OPTIONS") {
    sendJsonResponse(res, 204, {});
    return true;
  }

  try {
    if (requestUrl.pathname === "/api/catalog" && req.method === "GET") {
      sendJsonResponse(res, 200, await getPlatformCatalog());
      return true;
    }

    if (requestUrl.pathname === "/api/auth/telegram" && req.method === "POST") {
      const body = await readJsonRequest(req);
      const telegramUser = verifyTelegramLoginPayload(body.telegram_user || body);
      const account = await getPlatformAccount(telegramUser);
      sendJsonResponse(res, 200, {
        ...account,
        session_token: createWebSessionToken(telegramUser),
        expires_in: WEB_SESSION_MAX_AGE_SECONDS,
      });
      return true;
    }

    if (requestUrl.pathname === "/api/auth/browser-link" && req.method === "POST") {
      const body = await readJsonRequest(req);
      const telegramUser = resolvePlatformTelegramUser(req, body);
      const sessionToken = createWebSessionToken(telegramUser);
      sendJsonResponse(res, 200, {
        url: `${MINI_APP_URL}/#tg_session=${encodeURIComponent(sessionToken)}`,
      });
      return true;
    }

    if (requestUrl.pathname === "/api/account" && req.method === "POST") {
      const body = await readJsonRequest(req);
      sendJsonResponse(
        res,
        200,
        await getPlatformAccount(resolvePlatformTelegramUser(req, body))
      );
      return true;
    }

    if (
      requestUrl.pathname === "/api/history-download" &&
      req.method === "POST"
    ) {
      const body = await readJsonRequest(req);
      const telegramUser = resolvePlatformTelegramUser(req, body);
      const kind = body.kind === "custom" ? "custom" : "template";
      await getOwnedHistoryVideo(telegramUser.id, kind, body.item_id);
      const token = createHistoryDownloadToken(
        telegramUser.id,
        kind,
        body.item_id
      );
      sendJsonResponse(res, 200, {
        download_url: `${publicRequestBaseUrl(req)}/api/history-file?token=${encodeURIComponent(token)}`,
        file_name: `redaktop-${body.item_id}.mp4`,
        expires_in: HISTORY_DOWNLOAD_MAX_AGE_SECONDS,
      });
      return true;
    }

    if (
      requestUrl.pathname === "/api/history-file" &&
      req.method === "GET"
    ) {
      await streamHistoryVideo(req, res, requestUrl.searchParams.get("token"));
      return true;
    }

    if (
      requestUrl.pathname === "/api/genjutsu-presets" &&
      req.method === "POST"
    ) {
      const body = await readJsonRequest(req);
      resolvePlatformTelegramUser(req, body);
      sendJsonResponse(res, 200, { presets: await getGenjutsuPresets() });
      return true;
    }

    if (requestUrl.pathname === "/api/history" && req.method === "POST") {
      const body = await readJsonRequest(req);
      sendJsonResponse(res, 200, {
        orders: await getPlatformHistory(resolvePlatformTelegramUser(req, body)),
      });
      return true;
    }

    if (requestUrl.pathname === "/api/orders" && req.method === "POST") {
      const body = await readJsonRequest(req);
      sendJsonResponse(
        res,
        201,
        await createPaidPlatformOrder(
          resolvePlatformTelegramUser(req, body),
          body.template_slug,
          body.photo_urls,
          body.resolution,
          body.template_options
        )
      );
      return true;
    }

    if (
      requestUrl.pathname === "/api/custom-generations" &&
      req.method === "POST"
    ) {
      const body = await readJsonRequest(req);
      sendJsonResponse(
        res,
        201,
        await createPaidCustomGeneration(resolvePlatformTelegramUser(req, body), body)
      );
      return true;
    }

    if (
      requestUrl.pathname === "/api/token-checkout" &&
      req.method === "POST"
    ) {
      const body = await readJsonRequest(req);
      sendJsonResponse(
        res,
        200,
        await createTokenCheckout(
          resolvePlatformTelegramUser(req, body),
          body.package_id,
          body.legal_accepted
        )
      );
      return true;
    }

    sendJsonResponse(res, 404, { error: "API endpoint not found" });
  } catch (error) {
    console.error("Platform API error:", error.message);
    if (!res.headersSent) {
      sendJsonResponse(res, error.statusCode || 500, {
        error: error.message,
        code: error.apiCode || undefined,
        details: error.details || undefined,
      });
    } else {
      res.destroy(error);
    }
  }

  return true;
}

function sendHttpResponse(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

async function handleHttpRequest(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (await handlePlatformApiRequest(req, res, requestUrl)) {
    return;
  }

  if (requestUrl.pathname === "/" || requestUrl.pathname === "/health") {
    sendHttpResponse(res, 200, "OK");
    return;
  }

  if (requestUrl.pathname !== "/robokassa-result") {
    sendHttpResponse(res, 404, "Not found");
    return;
  }

  if (req.method !== "GET" && req.method !== "POST") {
    sendHttpResponse(res, 405, "Method not allowed");
    return;
  }

  try {
    const body = req.method === "POST" ? await readRequestBody(req) : "";
    const params = parseRequestParams(req, body);
    const invId = await handleRobokassaResult(params);

    sendHttpResponse(res, 200, `OK${invId}`);
  } catch (error) {
    console.error("Robokassa result error:", error.message);
    sendHttpResponse(res, error.statusCode || 500, error.message);
  }
}

function startHttpServer() {
  const port = Number(process.env.PORT || 3000);
  const server = http.createServer((req, res) => {
    handleHttpRequest(req, res).catch((error) => {
      console.error("HTTP server error:", error.message);
      sendHttpResponse(res, 500, "Internal server error");
    });
  });

  server.listen(port, () => {
    console.log(`HTTP server listening on port ${port}`);
  });

  return server;
}

async function ensureBuiltInTemplates() {
  const { error } = await supabase
    .from("templates")
    .upsert(BUILT_IN_TEMPLATE_ROWS, { onConflict: "slug" });

  if (error) {
    throw new Error(`Built-in template sync failed: ${error.message}`);
  }

  console.log("Built-in templates synchronized");
}

async function startWorker() {
  console.log("Higgsfield worker started");

  if (process.env.HIGGSFIELD_DEBUG_MODELS === "true") {
    await debugListHiggsfieldModels();
  }

  startHttpServer();

  await ensureBuiltInTemplates().catch((error) => {
    console.error(error.message);
  });

  await configureTelegramBot();
  await configureSupportTelegramBot().catch((error) => {
    console.error("Support bot setup failed:", error.message);
  });

  setInterval(checkOrders, CHECK_INTERVAL_MS);
  setInterval(checkCustomGenerations, CHECK_INTERVAL_MS);
  setInterval(checkTelegramUpdates, 3000);
  setInterval(checkSupportTelegramUpdates, 3000);

  checkOrders();
  checkCustomGenerations();
  checkTelegramUpdates();
  checkSupportTelegramUpdates();
}

startWorker();
