const { createClient } = require("@supabase/supabase-js");
const { execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs/promises");
const http = require("http");
const os = require("os");
const path = require("path");
const ffmpegPath = require("ffmpeg-static");
const sharp = require("sharp");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CHECK_INTERVAL_MS = 15000;
const GENERATION_MAX_ATTEMPTS = 3;
const HIGGSFIELD_API_BASE_URL =
  process.env.HIGGSFIELD_API_BASE_URL || "https://platform.higgsfield.ai";
const HIGGSFIELD_POLL_INTERVAL_MS = 10000;
const HIGGSFIELD_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_PHOTO_MODEL = "nano_banana";
const DEFAULT_VIDEO_MODEL = "seedance_2";
const PHOTO_MODEL_ALIASES = {
  nano_banana: "nano_banana_2",
  nano_banana_2: "nano_banana_2",
  nano_banana_pro: "nano_banana_pro",
};
const VIDEO_MODEL_ALIASES = {
  seedance_2: "seedance_2_0",
  seedance_2_0: "seedance_2_0",
  kling_3: "kling_3",
  kling_3_0: "kling_3_0",
  veo_3: "veo_3",
  wan_2_2: "wan_2_2",
  wan_2_5: "wan_2_5",
};
let telegramUpdateOffset = 0;

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
  const response = await fetch(getHiggsfieldUrl(pathname), {
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

  const data = await readJsonResponse(response);

  if (!response.ok) {
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
  });

  const generationId = extractGenerationId(result);

  if (!generationId) {
    throw new Error("Higgsfield createGeneration did not return generation_id");
  }

  console.log("generation_id", generationId);

  return generationId;
}

async function pollGeneration(generationId) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < HIGGSFIELD_POLL_TIMEOUT_MS) {
    const result = await higgsfieldRequest(
      `/requests/${encodeURIComponent(generationId)}/status`
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

      const generationId = await createGeneration(modelId, payload);
      return await pollGeneration(generationId);
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

  return model.trim().toLowerCase();
}

function resolvePhotoModel(model) {
  const normalizedModel = normalizeTemplateModel(model, DEFAULT_PHOTO_MODEL);
  const resolvedModel = PHOTO_MODEL_ALIASES[normalizedModel];

  if (!resolvedModel) {
    throw new Error(`Unsupported photo model: ${model}`);
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
async function sendTelegramErrorMessage(order) {
  if (!process.env.BOT_TOKEN) {
    console.log("No BOT_TOKEN found, skipping error message");
    return false;
  }

  if (!order.telegram_user_id) {
    console.log("No telegram_user_id for error message:", order.id);
    return false;
  }

  try {
    await telegramApi("sendMessage", {
      chat_id: order.telegram_user_id,
      text:
        "⚠️ Произошла ошибка генерации.\n\n" +
        "Попробуйте снова, пожалуйста.",
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

async function sendSubscriptionRequiredMessage(chatId, templateSlug = "repeat_001") {
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

function getRobokassaConfig() {
  const merchantLogin = process.env.ROBOKASSA_MERCHANT_LOGIN;
  const password1 = process.env.ROBOKASSA_PASSWORD1;
  const password2 = process.env.ROBOKASSA_PASSWORD2;

  if (!merchantLogin || !password1 || !password2) {
    throw new Error("Robokassa env vars are not configured");
  }

  return {
    merchantLogin,
    password1,
    password2,
    isTest: ["1", "true", "yes"].includes(
      String(process.env.ROBOKASSA_TEST || "").toLowerCase()
    ),
  };
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
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
  const { merchantLogin, password1, isTest } = getRobokassaConfig();
  const outSum = formatRobokassaOutSum(order.price_rub);
  const invId = createRobokassaInvoiceId(order.id);
  const shpParams = {
    Shp_orderId: String(order.id),
  };
  const shpTail = getShpSignatureTail(shpParams);
  const signatureBase = `${merchantLogin}:${outSum}:${invId}:${password1}:${shpTail}`;
  const signature = sha256Hex(signatureBase);
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

  return paymentUrl.toString();
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
    "https://telegra.ph/Oferta-servisa-Povtori-Video-Bot-05-13";

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
  const templateSlug = parts[1] || "repeat_001";
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

  await telegramApi("sendMessage", {
    chat_id: chatId,
    text:
  "🎬 ПОВТОРИ ВИДЕО БОТ\n\n" +
  "Создание AI-видео по вашим фотографиям с помощью нейросетей.\n\n" +
  "👤 ИП: Краснов Иван Сергеевич\n" +
  "🧾 ИНН: 212501999935\n\n" +
  "📌 Услуга:\n" +
  "Создание персонализированных AI-видео на основе загруженных пользователем фотографий.\n\n" +
  "🌍 Регионы оказания услуг:\n" +
  "Услуга предоставляется онлайн для пользователей из любых регионов.\n\n" +
  "💳 Оплата:\n" +
  "Оплата производится через Telegram Stars и банковские карты/СБП через Robokassa.\n\n" +
  "↩️ Возврат:\n" +
  "Если генерация видео не удалась по технической причине и результат не был предоставлен — возможен возврат средств.\n\n" +
  "⏱ Срок оказания услуги:\n" +
  "Обычно генерация занимает от 1 до 10 минут.\n\n" +
  "📄 Оферта:\n" +
  "https://telegra.ph/Oferta-servisa-Povtori-Video-Bot-05-13\n\n" +
  "Нажмите кнопку ниже, чтобы загрузить фото и создать видео.",
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

async function createPhotoGeneration(model, prompt, photoUrls) {
  const inputImages = photoUrls.map((imageUrl) => ({
    type: "image_url",
    image_url: imageUrl,
  }));

  return runGenerationWithRetries(
    "Photo generation",
    model,
    {
      prompt,
      input_images: inputImages,
      aspect_ratio: "9:16",
      resolution: "2k",
    }
  );
}

function buildVideoPayload(
  prompt,
  imageUrl,
  duration,
  resolution,
  aspectRatio,
  options = {}
) {
  const imageMode = options.imageMode || "reference";
  const payload = {
    prompt,
    aspect_ratio: aspectRatio,
    duration,
    resolution,
    mode: options.mode || "std",
    genre: options.genre || "auto",
  };

  if (imageMode === "start_frame") {
    console.log("Video image mode: start_frame");

    payload.image_url = imageUrl;
  } else {
    console.log("Video image mode: reference");

    payload.medias = [
      {
        data: {
          type: "image_url",
          image_url: imageUrl,
        },
        role: "image",
      },
    ];
  }

  return payload;
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
  return runGenerationWithRetries(
    "Video generation",
    model,
    buildVideoPayload(
      prompt,
      enhancedPhoto,
      duration,
      resolution,
      aspectRatio,
      options
    )
  );
}

async function processOrder(order) {
  console.log("Processing order:", order.id);
  const subscribed = await isUserSubscribedToChannel(order.telegram_user_id);

  if (!subscribed) {
    console.log("User is not subscribed, stopping order:", order.id);

    await sendSubscriptionRequiredMessage(
      order.telegram_user_id,
      order.template_slug
    );

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
  if (order.status === "video_ready_locked" && order.video_url) {
  console.log("Recovering video_ready_locked order:", order.id);

  let previewImageUrl = order.preview_image_url;

  if (!previewImageUrl) {
    previewImageUrl = await createBlurredPreview(order.video_url, order.id);

    await supabase
      .from("orders")
      .update({
        preview_image_url: previewImageUrl,
        updated_at: new Date().toISOString(),
      })
      .eq("id", order.id);
  }

  if (!order.bot_message_sent) {
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
  }

  console.log("Recovered completed order:", order.id);
  return;
}
const resolvedPhotoModel = resolvePhotoModel(template.photo_model);
const resolvedVideoModel = resolveVideoModel(template.video_model);
const videoDuration = getTemplateInteger(
  template.video_duration,
  getTemplateInteger(template.duration, 5)
);
const videoResolution = getTemplateText(
  template.video_resolution,
  getTemplateText(template.resolution, "720p")
);
const videoAspectRatio = getTemplateText(
  template.video_aspect_ratio,
  getTemplateText(template.aspect_ratio, "16:9")
);

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
      mode: getTemplateText(template.mode, "std"),
      genre: getTemplateText(template.genre, "auto"),
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
  .or(
    "status.in.(photo_uploaded,photo_ready),and(status.eq.video_ready_locked,bot_message_sent.is.false),and(status.eq.video_ready_locked,bot_message_sent.is.null)"
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

const errorSent = await sendTelegramErrorMessage(order);

await supabase
  .from("orders")
  .update({
    status: "failed",
    error_message: error.message,
    bot_error_message_sent: errorSent,
    bot_error_message_sent_at: errorSent ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  })
  .eq("id", order.id);
    }
  }
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
  const { password2 } = getRobokassaConfig();
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
  const expectedSignature = sha256Hex(signatureBase);

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

async function handleRobokassaResult(params) {
  const { outSum, invId } = assertRobokassaSignature(params);
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

  if (!order.paid) {
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

function sendHttpResponse(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

async function handleHttpRequest(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

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

async function startWorker() {
  console.log("Higgsfield worker started");
  startHttpServer();

  setInterval(checkOrders, CHECK_INTERVAL_MS);
  setInterval(checkTelegramUpdates, 3000);

  checkOrders();
  checkTelegramUpdates();
}

startWorker();
