import TelegramBot from "node-telegram-bot-api";
import mongoose from "mongoose";
import dotenv from "dotenv";
import express from "express";

dotenv.config();

// === ENV SETTINGS ===
const TOKEN = process.env.TG_BOT_TOKEN;
const CHANNEL = process.env.TG_CHANNEL || "@xdev_blog";
const ADMINS = (process.env.ADMINS || "")
  .split(",")
  .filter(Boolean)
  .map(Number);
const MAIN_ADMIN_ID = Number(process.env.MAIN_ADMIN_ID || "0");

const USERS_MONGO_URI = process.env.USERS_MONGO_URI;
const BUYERS_MONGO_URI = process.env.BUYERS_MONGO_URI;
const TESTS_MONGO_URI = process.env.TESTS_MONGO_URI;
const CLOSE_TEST_MONGO_URI = process.env.CLOSE_TEST_MONGO_URI;

const RATE_LIMIT_DELAY = Number(process.env.RATE_LIMIT_DELAY_MS || 120);

// === BOT SETUP ===
if (!TOKEN) {
  console.error("❌ ERROR: TG_BOT_TOKEN not set in .env");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

// Helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAdmin = (id) => ADMINS.includes(id) || id === MAIN_ADMIN_ID;
const isMainAdmin = (id) => Number(id) === MAIN_ADMIN_ID;
const isRegularAdmin = (id) =>
  ADMINS.includes(id) && Number(id) !== MAIN_ADMIN_ID;

// HTTPS Web App URL resolver
function getWebAppUrl() {
  const raw = String(process.env.WEB_APP_URL || "").trim();
  if (raw && /^https:\/\//i.test(raw)) return raw;
  return null;
}

// Helper: send link to start closed tests
async function sendClosedTestLink(userId) {
  const url = getWebAppUrl();
  if (!url) throw new Error("WEB_APP_URL must be https");
  await bot.sendMessage(userId, `Yopiq testni ishga tushiring: ${url}`);
}

// === DATABASE CONNECTIONS ===
async function connectDBs() {
  try {
    // Asosiy users DB ulanishi
    await mongoose.connect(USERS_MONGO_URI, {});
    console.log("✅ Connected to USERS DB");
  } catch (e) {
    console.error("❌ USERS DB connection error:", e.message || e);
    process.exit(1);
  }

  // Buyers DB uchun alohida connection
  const buyerConn = await mongoose
    .createConnection(BUYERS_MONGO_URI, {})
    .asPromise();
  console.log("✅ Connected to BUYERS DB");
  const testConn = await mongoose
    .createConnection(TESTS_MONGO_URI, {})
    .asPromise();
  console.log("✅ Connected to TESTS DB");
  const closeTestConn = await mongoose
    .createConnection(CLOSE_TEST_MONGO_URI, {})
    .asPromise();
  console.log("✅ Connected to CLOSE_TEST DB");

  return { buyerConn, testConn, closeTestConn };
}

// === INIT ===
(async () => {
  const { buyerConn, testConn, closeTestConn } = await connectDBs();

  // ====== Schemas ======
  const usersSchema = new mongoose.Schema({
    ids: { type: [Number], default: [] },
  });

  // Global test progress flag to prevent duplicate starts
  let testsInProgress = false;

  // Shared: show users count
  async function handleShowUsers(adminId) {
    const doc = await Users.findOne();
    return bot.sendMessage(
      adminId,
      `👥 Userlar soni: ${doc?.ids?.length || 0}`
    );
  }

  // /userlarsoni command (single handler)
  bot.onText(/\/userlarsoni$/, async (msg) => {
    const adminId = msg.chat.id;
    if (!isAdmin(adminId)) return;
    await handleShowUsers(adminId);
  });

  // Shared: show buyers list
  async function handleShowBuyers(adminChatId) {
    const buyers = await Buyers.find().lean();
    if (!buyers.length) return bot.sendMessage(adminChatId, "🚫 Buyers yo'q");

    const rows = [];
    for (const b of buyers) {
      let name = "—";
      try {
        const chat = await bot.getChat(b.userId);
        name = chat.first_name || chat.username || "—";
      } catch (e) {
        try {
          const member = await bot.getChatMember(CHANNEL, b.userId);
          const u = member?.user;
          if (u) {
            name = u.first_name || u.username || name;
          }
        } catch (_) {}
      }
      const degree = b.degree || "—";
      rows.push(
        `👤 ${name} |🆔 ${b.userId} |🎯 ${
          b.score.toFixed(1) || 0
        } |🎓 ${degree}`
      );
    }

    while (rows.length) {
      await bot.sendMessage(adminChatId, rows.splice(0, 20).join("\n"));
      await sleep(100);
    }
  }

  // /ishtirokchilar command (renamed from /showbuyers)
  bot.onText(/\/ishtirokchilar/, async (msg) => {
    const adminChatId = msg.chat.id;
    const fromId = msg.from.id;
    if (!isAdmin(fromId)) return;
    await handleShowBuyers(adminChatId);
  });

  // Removed text-button mirror (use /ishtirokchilar)

  // Shared: show all results
  async function handleShowAllResults(adminId) {
    const buyers = await Buyers.find().lean();
    if (!buyers.length) return bot.sendMessage(adminId, "🚫 Buyers yo‘q");

    let lines = [];
    const allTests = await Tests.find().lean();
    const totalPossible = allTests.reduce((s, t) => s + (t.score || 1), 0) || 1;

    for (const b of buyers) {
      let name = "?";
      try {
        const c = await bot.getChat(b.userId);
        name = c.first_name || c.username || "?";
      } catch (e) {}
      const percent =
        Math.round((b.score.toFixed(1) / totalPossible.toFixed(1)) * 1000) / 10;
      lines.push(
        `${name} |🎯${b.score.toFixed(1)} |📈${percent}%|🎓${b.degree}`
      );
    }

    while (lines.length)
      await bot.sendMessage(adminId, lines.splice(0, 20).join("\n"));
  }

  // /natijalar command (renamed from /showallresults)
  bot.onText(/\/natijalar/, async (msg) => {
    const adminId = msg.chat.id;
    if (!isAdmin(adminId)) return;
    await handleShowAllResults(adminId);
  });

  // Removed text-button mirror (use /natijalar)

  const BuyersSchema = new mongoose.Schema({
    userId: { type: Number, required: true, unique: true },
    correctAnswers: { type: [String], default: [] },
    wrongAnswers: { type: [String], default: [] },
    score: { type: Number, default: 0 },
    finished: { type: Boolean, default: false },
    closeTestFinished: { type: Boolean, default: false },
    degree: { type: String, default: "—" },
    answers: { type: Map, of: String, default: {} },
    lastAnswer: {
      qNumber: { type: Number, default: null },
      choiceIdx: { type: Number, default: null },
    },
  });
  const testsSchema = new mongoose.Schema({
    number: { type: Number, unique: true },
    options: { type: [String], default: ["A", "B", "C", "D"] },
    answer: { type: String, required: true },
    score: { type: Number, default: 1 },
  });
  const closeTestSchema = new mongoose.Schema({
    number: { type: Number, unique: true },
    answerA: {
      value: { type: String, required: true },
      score: { type: Number, default: 1 },
    },
    answerB: {
      value: { type: String, required: true },
      score: { type: Number, default: 1 },
    },
  });
  // Models
  const Users = mongoose.model("Users", usersSchema); // default conn
  const Buyers = buyerConn.model("Buyer", BuyersSchema);
  const Tests = testConn.model("Test", testsSchema);
  const CloseTests = closeTestConn.model("CloseTest", closeTestSchema);

  // Ensure correct indexes on Buyers and clean up legacy ones
  try {
    // Drop legacy incorrect index if exists (id_1)
    await Buyers.collection.dropIndex("id_1");
  } catch (e) {
    // ignore if index doesn't exist
  }
  try {
    await Buyers.createIndexes();
  } catch (e) {
    console.warn("Buyers.createIndexes warning:", e?.message || e);
  }

  function parseCorrectIndex(test) {
    if (!test) return NaN;
    const ans = String(test.answer || "").trim();
    if (!ans) return NaN;
    if (ans.length === 1 && ans >= "A" && ans <= "Z")
      return ans.charCodeAt(0) - 65;
    const n = Number(ans);
    return isNaN(n) ? NaN : n;
  }

  // === START ===
  // Helper: show Admin control panel keyboard
  function sendAdminPanel(chatId) {
    return bot.sendMessage(chatId, "🔧 Admin boshqaruvi:", {
      reply_markup: {
        keyboard: [
          [{ text: "/testlarniko'rish" }, { text: "/userlarsoni" }],
          [{ text: "/ishtirokchilar" }, { text: "/natijalar" }],
          [
            { text: "/testlarnio'chirish" },
            { text: "/ishtirokchilarnio'chirish" },
          ],
          [{ text: "/testyaratish" }, { text: "/testniboshlash" }],
          [{ text: "/yopiqtestyaratish" }, { text: "/yopiqtestniko'rish" }],
          [{ text: "/testni_tugatish" }, { text: "/yopiqtesto'chirish" }],
        ],
        resize_keyboard: true,
        one_time_keyboard: false,
      },
    });
  }

  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    let doc = await Users.findOne();
    if (!doc) doc = await Users.create({ ids: [] });
    if (!doc.ids.includes(chatId)) {
      doc.ids.push(chatId);
      await doc.save();
    }

    try {
      const member = await bot.getChatMember(CHANNEL, chatId);
      if (["member", "administrator", "creator"].includes(member.status)) {
        await bot.sendMessage(
          chatId,
          `Assalomu alaykum, ${msg.chat.first_name || "foydalanuvchi"}!`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "🛒 Test sotib olish",
                    url: "https://t.me/rayimberdiyev_08",
                  },
                ],
                [{ text: "📋 Profil", callback_data: "profile" }],
              ],
            },
          }
        );
        if (isAdmin(chatId)) {
          await sendAdminPanel(chatId);
        }
        return;
      }
    } catch (err) {
      // silently ignore (user not a member or other error)
    }

    await sendSubscribeMessage(chatId);
  });

  // Command: /admin — show Admin panel on demand
  bot.onText(/^\/admin$/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return;
    await sendAdminPanel(chatId);
  });

  // CALLBACKS
  bot.on("callback_query", async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;
    const fromId = query.from.id;
    if (data === "profile") {
      const buyer = await Buyers.findOne({ userId: fromId });
      return bot.sendMessage(
        fromId,
        `👤 Ism: ${
          query.from.first_name || "—"
        }\n🆔 ID: <code>${fromId}</code>\n🎯 Ball: ${
          buyer?.score || 0
        }\n🎓 Daraja: ${buyer?.degree || "—"}`,
        { parse_mode: "HTML" }
      );
    }
    if (data === "check_sub") {
      try {
        const member = await bot.getChatMember(CHANNEL, fromId);
        if (["member", "administrator", "creator"].includes(member.status)) {
          await bot.editMessageText(
            "✅ Obuna tasdiqlandi! /start ni qayta bosing.",
            {
              chat_id: chatId,
              message_id: query.message.message_id,
            }
          );
        } else
          await bot.answerCallbackQuery(query.id, {
            text: "❌ Hali obuna bo‘lmagansiz!",
            show_alert: true,
          });
      } catch (e) {
        await bot.answerCallbackQuery(query.id, {
          text: "❌ Obuna tekshirishda xato!",
          show_alert: true,
        });
      }
    }
  });
  // SUBSCRIBE UI
  const sendSubscribeMessage = (chatId) =>
    bot.sendMessage(chatId, "📢 Kanalga obuna bo‘ling:", {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "📌 Obuna bo‘lish",
              url: `https://t.me/${CHANNEL.replace(/^@/, "")}`,
            },
          ],
          [{ text: "✅ Tekshirish", callback_data: "check_sub" }],
        ],
      },
    });

  bot.onText(/\/buy(?:\s+(.+))?/, async (msg, match) => {
    const adminUserId = msg.from.id;
    const replyChatId = msg.chat.id;
    if (!isAdmin(adminUserId)) {
      return bot.sendMessage(replyChatId, "❌ Bu buyruq faqat adminlar uchun!");
    }

    const text = msg.text || "";
    const ids = (text.match(/\d+/g) || []).map(Number);
    if (!ids.length) {
      return bot.sendMessage(
        replyChatId,
        "❌ Noto'g'ri ID. /buy <id> yoki bir nechta ID yuboring."
      );
    }

    const results = [];
    for (const userId of ids) {
      if (!Number.isFinite(userId)) {
        results.push(`🆔 ${userId}: ❌ Noto'g'ri ID`);
        continue;
      }
      try {
        const res = await Buyers.updateOne(
          { userId },
          {
            $setOnInsert: {
              userId,
              score: 0,
              correctAnswers: [],
              wrongAnswers: [],
              finished: false,
              degree: "—",
              lastAnswer: { qNumber: null, choiceIdx: null },
            },
          },
          { upsert: true }
        );

        if (res.upsertedCount && res.upsertedCount > 0) {
          results.push(`🆔 ${userId}: ✅ Qo‘shildi`);
        } else if (res.matchedCount && res.matchedCount > 0) {
          results.push(`🆔 ${userId}: ⚠️ Allaqachon mavjud`);
        } else {
          results.push(`🆔 ${userId}: ❌ Noma'lum holat`);
        }
      } catch (err) {
        console.error("/buy error:", err);
        if (
          err?.code === 11000 ||
          (err?.message && err.message.includes("duplicate"))
        ) {
          results.push(`🆔 ${userId}: ⚠️ Allaqachon mavjud`);
        } else {
          results.push(`🆔 ${userId}: ❌ Xatolik`);
        }
      }
    }

    const response = results.join("\n");
    return bot.sendMessage(replyChatId, response);
  });

  // ====== /kim <id> (admin) ======
  bot.onText(/\/kim (\d+)/, async (msg, match) => {
    const adminId = msg.chat.id;
    if (!isAdmin(adminId))
      return bot.sendMessage(adminId, "❌ Bu buyruq faqat adminlar uchun!");

    const userId = Number(match[1]);
    try {
      const chat = await bot.getChat(userId);
      const name = chat.first_name || chat.username || "—";
      const buyer = await Buyers.findOne({ userId });

      if (buyer) {
        return bot.sendMessage(
          adminId,
          `👤 ${name}\n🆔 ${userId}\n🎯 Ball: ${buyer.score}\nTo'g'ri: ${
            (buyer.correctAnswers || []).length
          }\nXato: ${(buyer.wrongAnswers || []).length}\nTugatgan: ${
            buyer.finished ? "Ha" : "Yo‘q"
          }`
        );
      }

      return bot.sendMessage(
        adminId,
        `👤 ${name}\n🆔 ${userId}\nℹ️ Bu user Buyer emas`
      );
    } catch (e) {
      return bot.sendMessage(adminId, `❌ Foydalanuvchi topilmadi: ${userId}`);
    }
  });

  // === ADMIN TEST CREATION ===
  const creatingTestSessions = {}; // adminId => session

  bot.onText(/^\/testyaratish(?: (\d+))?$/, async (msg, match) => {
    if (!isMainAdmin(msg.chat.id)) return;

    const adminId = msg.chat.id;
    const startNumber = match[1] ? Number(match[1]) : null;

    creatingTestSessions[adminId] = {
      step: 1,
      data: { number: startNumber || null },
      tempQuestions: [],
      currentQuestion: null,
    };

    await bot.sendMessage(
      adminId,
      `🛠 Test yaratish boshlandi.\n1️⃣ Savol raqamini kiriting\n2️⃣ Savol Variantlari\n3️⃣ To'g'ri javob(A,B,C...)\n4️⃣ Ball\nTugatgach /testyaratishni_tugat yozing.`
    );
  });

  // Admin message handler for test creation (only when session exists)
  bot.on("message", async (msg) => {
    const adminId = msg.chat.id;
    if (!isMainAdmin(adminId)) return;

    const session = creatingTestSessions[adminId];
    if (!session) return; // only handle messages if session exists

    const step = session.step;

    // If starting number is not set yet, allow the admin to input it first
    if (
      session.data &&
      session.data.number == null &&
      msg.text &&
      /^\d+$/.test(msg.text.trim())
    ) {
      session.data.number = Number(msg.text.trim());
      await bot.sendMessage(
        adminId,
        "✅ Savol raqami qabul qilindi. Endi variantlar sonini kiriting(2/3/4)."
      );
      return;
    }

    // /testyaratishni_tugat (also accept /testyaratishni_tugatish)
    if (msg.text && /^\/testyaratishni_tugat(ish)?$/.test(msg.text.trim())) {
      if (!session.tempQuestions.length) {
        await bot.sendMessage(adminId, "⚠️ Hech qanday savol qo‘shilmadi.");
        delete creatingTestSessions[adminId];
        return;
      }

      let baseNumber = session.data.number;
      if (!baseNumber) {
        const c = await Tests.countDocuments();
        baseNumber = c + 1;
      }

      for (let i = 0; i < session.tempQuestions.length; i++) {
        const q = session.tempQuestions[i];
        const number = baseNumber + i;

        await Tests.updateOne(
          { number },
          {
            $set: {
              number,
              options: q.options,
              answer: q.answer,
              score: q.score,
            },
          },
          { upsert: true }
        );
      }

      const totalTests = await Tests.countDocuments();
      await bot.sendMessage(
        adminId,
        `✅ Savol saqlandi!\n${totalTests} ta test bor.\n /testyaratish`
      );

      delete creatingTestSessions[adminId];
      return;
    }

    // Step 1: Variantlar
    if (step === 1 && msg.text) {
      if (!session.currentQuestion) session.currentQuestion = {};

      const raw = msg.text.trim();
      const numericCount = /^\d+$/.test(raw) ? Number(raw) : null;

      let opts;
      if (numericCount && [2, 3, 4].includes(numericCount)) {
        opts = Array.from({ length: numericCount }, (_, i) =>
          String.fromCharCode(65 + i)
        );
      } else {
        opts = raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }

      if (opts.length < 2)
        return bot.sendMessage(adminId, "⚠️ Kamida 2 ta variant kiriting.");

      session.currentQuestion.options = opts;
      session.step = 2;
      await bot.sendMessage(
        adminId,
        "✅ To‘g‘ri javobni kiriting (masalan: A):"
      );
      return;
    }

    // Step 2: To'g'ri javob
    if (step === 2 && msg.text) {
      session.currentQuestion.answer = msg.text.trim().toUpperCase();
      session.step = 3;
      await bot.sendMessage(adminId, "🎯 Ballni kiriting (raqam):");
      return;
    }

    // Step 3: Ball
    if (step === 3 && msg.text) {
      const score = Number(msg.text.trim());
      if (isNaN(score))
        return bot.sendMessage(
          adminId,
          "⚠️ Ball raqami bo‘lishi kerak. Qayta yuboring."
        );

      session.currentQuestion.score = score;

      // Savolni qo'shish
      session.tempQuestions.push({ ...session.currentQuestion });
      session.currentQuestion = null;
      session.step = 1;

      await bot.sendMessage(
        adminId,
        "➕ Savol qo‘shildi. /testyaratishni_tugat yozing."
      );
    }
  });

  // Shared: show tests to admin
  async function handleShowTests(adminId) {
    try {
      const tests = await Tests.find().sort({ number: 1 }).lean();

      if (!tests.length) {
        return bot.sendMessage(adminId, "⚠️ Hozircha testlar mavjud emas.");
      }

      for (const t of tests) {
        let message = `#️⃣ Test №${t.number}`;

        // // Variantlarni chiqaramiz
        // t.options.forEach((opt, idx) => {
        //   const letter = String.fromCharCode(65 + idx); // 65 = 'A'
        //   message += `${letter}) ${opt}\n`;
        // });

        message += `\n✅ To‘g‘ri javob: ${t.answer}\n`;
        message += `🏆 Ball: ${t.score.toFixed(1)}`;

        await bot.sendMessage(adminId, message);
      }
    } catch (err) {
      console.error("/testlarniko'rish error:", err);
      bot.sendMessage(adminId, "❌ Testlarni olishda xatolik yuz berdi.");
    }
  }

  // === /testlarniko'rish komandasi (renamed from /showtests) ===
  bot.onText(/\/testlarniko'rish/, async (msg) => {
    const adminId = msg.chat.id;
    if (!isAdmin(adminId)) {
      return bot.sendMessage(adminId, "❌ Bu buyruq faqat adminlar uchun!");
    }
    await handleShowTests(adminId);
  });

  // ====== /testniboshlash (admin) ======
  async function sendAllTestsToBuyers(adminId) {
    const buyers = await Buyers.find({}).lean();
    const tests = await Tests.find().sort({ number: 1 }).lean();
    if (!tests.length)
      return bot.sendMessage(adminId, "🚫 Testlar mavjud emas.");
    if (!buyers.length)
      return bot.sendMessage(adminId, "🚫 Buyers mavjud emas.");

    for (const buyer of buyers) {
      if (buyer.finished) continue;

      // 1-savoldan boshlaymiz
      await sendTestQuestion(buyer.userId, tests, 0);
      await sleep(RATE_LIMIT_DELAY);
    }

    await bot.sendMessage(
      adminId,
      `✅ Testlar yuborildi (${buyers.length} buyers).`
    );
  }

  async function sendTestQuestion(userId, tests, index) {
    const t = tests[index];
    if (!t) return;

    const isFirst = index === 0;
    const isLast = index === tests.length - 1;

    const optsRow = t.options.map((opt, idx) => ({
      text: String.fromCharCode(65 + idx),
      callback_data: `pick_${t.number}_${idx}`,
    }));

    const navRow = [];
    if (!isFirst)
      navRow.push({ text: "⬅️ Orqaga", callback_data: `nav_${index - 1}` });
    if (!isLast)
      navRow.push({ text: "➡️ Oldinga", callback_data: `nav_${index + 1}` });
    if (isLast)
      navRow.push({ text: "🏁 Tugatish", callback_data: "finish_test" });

    const keyboard = { inline_keyboard: [optsRow] };
    if (navRow.length) keyboard.inline_keyboard.push(navRow);

    try {
      await bot.sendMessage(userId, `❓ ${t.number}-savol:`, {
        reply_markup: keyboard,
      });
    } catch (e) {
      console.log(`send to ${userId} failed:`, e?.message || e);
    }
  }

  bot.onText(/\/testniboshlash/, async (msg) => {
    const adminId = msg.chat.id;
    if (!isAdmin(adminId))
      return bot.sendMessage(adminId, "❌ Bu buyruq faqat adminlar uchun!");
    await sendAllTestsToBuyers(adminId);
  });

  // Yopiq test yaratish uchun state saqlash
  const closeTestState = {};

  // Boshlash
  bot.onText(/\/yopiqtestyaratish/, async (msg) => {
    const adminId = msg.chat.id;
    if (!isMainAdmin(adminId)) return;

    closeTestState[adminId] = { step: 1, data: {} };

    return bot.sendMessage(adminId, "✍️ 1-qadam: Savol raqamini kiriting:");
  });

  // Step-by-step jarayon
  bot.on("message", async (msg) => {
    const adminId = msg.chat.id;
    if (!isMainAdmin(adminId)) return;
    if (!closeTestState[adminId]) return;

    const state = closeTestState[adminId];
    const text = msg.text?.trim();

    switch (state.step) {
      case 1: {
        // Savol raqami
        if (!/^\d+$/.test(text)) {
          return bot.sendMessage(
            adminId,
            "❌ Savol raqami faqat son bo‘lishi kerak. Qaytadan kiriting:"
          );
        }
        state.data.number = Number(text);
        state.step = 2;
        return bot.sendMessage(adminId, "✍️ 2-qadam: A javobni kiriting:");
      }

      case 2: {
        // A javobi
        state.data.answerA = text;
        state.step = 3;
        return bot.sendMessage(
          adminId,
          "✍️ 3-qadam: A ballni kiriting yoki /skipAscore:"
        );
      }

      case 3: {
        // A ball
        if (text === "/skipAscore") {
          state.data.scoreA = 1.5;
        } else {
          if (!/^\d+(\.\d+)?$/.test(text)) {
            return bot.sendMessage(
              adminId,
              "❌ Ball faqat son bo‘lishi kerak. Qaytadan kiriting:"
            );
          }
          state.data.scoreA = Number(text);
        }
        state.step = 4;
        return bot.sendMessage(adminId, "✍️ 4-qadam: B javobni kiriting:");
      }

      case 4: {
        // B javobi
        state.data.answerB = text;
        state.step = 5;
        return bot.sendMessage(
          adminId,
          "✍️ 5-qadam: B ballni kiriting yoki /skipBscore:"
        );
      }

      case 5: {
        // B ball
        if (text === "/skipBscore") {
          state.data.scoreB = 1.7;
        } else {
          if (!/^\d+(\.\d+)?$/.test(text)) {
            return bot.sendMessage(
              adminId,
              "❌ Ball faqat son bo‘lishi kerak. Qaytadan kiriting:"
            );
          }
          state.data.scoreB = Number(text);
        }

        // DB ga yozish
        await CloseTests.updateOne(
          { number: state.data.number },
          {
            $set: {
              number: state.data.number,
              answerA: {
                value: state.data.answerA,
                score: state.data.scoreA,
              },
              answerB: {
                value: state.data.answerB,
                score: state.data.scoreB,
              },
            },
          },
          { upsert: true }
        );

        // State tozalash
        const saved = { ...state.data };
        delete closeTestState[adminId];

        return bot.sendMessage(
          adminId,
          `✅ Yopiq test saqlandi\n#️⃣ ${saved.number}-savol\n` +
            `✅ A: ${saved.answerA} (${saved.scoreA} ball)\n` +
            `✅ B: ${saved.answerB} (${saved.scoreB} ball)`
        );
      }
    }
  });

  // ====== /yopiqtestniko'rish (admin) ======
  bot.onText(/\/yopiqtestniko'rish/, async (msg) => {
    const adminId = msg.chat.id;
    if (!isAdmin(adminId)) {
      return bot.sendMessage(adminId, "❌ Bu buyruq faqat adminlar uchun!");
    }

    const items = await CloseTests.find().sort({ number: 1 }).lean();
    if (!items.length) {
      return bot.sendMessage(adminId, "⚠️ Hozircha yopiq testlar yo'q.");
    }

    for (const t of items) {
      const message = `#️⃣ ${t.number}-savol\n✅ A javob: ${
        t.answerA?.value || "N/A"
      } (${t.answerA?.score || 0} ball)\n✅ B javob: ${
        t.answerB?.value || "N/A"
      } (${t.answerB?.score || 0} ball)`;
      await bot.sendMessage(adminId, message);
    }
  });

  // ====== /yopiqtesto'chirish (admin) ======
  bot.onText(/\/yopiqtesto'chirish/, async (msg) => {
    const adminId = msg.chat.id;
    if (!isAdmin(adminId)) {
      return bot.sendMessage(adminId, "❌ Bu buyruq faqat adminlar uchun!");
    }
    await CloseTests.deleteMany({});
    return bot.sendMessage(adminId, "🗑️ Barcha yopiq testlar o'chirildi");
  });

  // ====== callback_query: pick / nav / finish_test ======
  bot.on("callback_query", async (query) => {
    const data = String(query.data || "");
    const userId = query.from.id;
    const qid = query.id;

    try {
      const buyer = await Buyers.findOne({ userId });
      if (!buyer) return;
      if (buyer.finished)
        return bot.answerCallbackQuery(qid, {
          text: "⚠️ Siz testni tugatgansiz.",
          show_alert: true,
        });

      // oldinga / orqaga tugmalari
      if (data.startsWith("nav_")) {
        const idx = Number(data.split("_")[1]);
        const tests = await Tests.find().sort({ number: 1 }).lean();
        await sendTestQuestion(userId, tests, idx);

        return bot.answerCallbackQuery(qid);
      }

      // 1) variant tanlash: pick_<qNumber>_<idx>
      if (data.startsWith("pick_")) {
        const parts = data.split("_");
        const qNumber = Number(parts[1]);
        const choiceIdx = Number(parts[2]);

        // Tanlovni saqlash
        const letter = String.fromCharCode(65 + choiceIdx);
        if (!buyer.answers) buyer.answers = new Map();
        buyer.answers.set(String(qNumber), letter);
        await buyer.save();

        // Inline keyboardni yangilash
        try {
          const tests = await Tests.find().sort({ number: 1 }).lean();
          const testIndex = tests.findIndex((t) => t.number === qNumber);
          const test = tests[testIndex];
          const isFirst = testIndex === 0;
          const isLast = testIndex === tests.length - 1;

          // variantlar
          const optsRow = test.options.map((opt, idx) => ({
            text: `${String.fromCharCode(65 + idx)}${
              idx === choiceIdx ? " ✅" : ""
            }`,
            callback_data: `pick_${qNumber}_${idx}`,
          }));

          // navigatsiya tugmalari
          const navRow = [];
          if (!isFirst)
            navRow.push({
              text: "⬅️ Orqaga",
              callback_data: `nav_${testIndex - 1}`,
            });
          if (!isLast)
            navRow.push({
              text: "➡️ Oldinga",
              callback_data: `nav_${testIndex + 1}`,
            });
          if (isLast)
            navRow.push({ text: "🏁 Tugatish", callback_data: "finish_test" });

          const newKeyboard = { inline_keyboard: [optsRow] };
          if (navRow.length) newKeyboard.inline_keyboard.push(navRow);

          await bot.editMessageReplyMarkup(newKeyboard, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
          });
        } catch (e) {
          console.error("editMessageReplyMarkup error:", e);
        }
      }

      // 2) testni tugatish
      if (data === "finish_test") {
        const allTests = await Tests.find().sort({ number: 1 }).lean();
        const answersMap = buyer.answers || new Map();
        let correct = 0;
        let wrong = 0;
        let earned = 0;

        buyer.correctAnswers = [];
        buyer.wrongAnswers = [];
        buyer.score = 0;

        for (const t of allTests) {
          const qNum = t.number;
          const picked = answersMap.get(String(qNum)) || "";
          const correctIdx = parseCorrectIndex(t);
          const correctLetter = !isNaN(correctIdx)
            ? String.fromCharCode(65 + correctIdx)
            : "";
          const isCorrect = picked && correctLetter && picked === correctLetter;
          if (isCorrect) {
            correct += 1;
            earned += t.score || 1;
            buyer.correctAnswers.push(qNum);
          } else {
            wrong += 1;
            buyer.wrongAnswers.push(qNum);
          }
        }

        buyer.finished = true;
        buyer.lastAnswer = { qNumber: null, choiceIdx: null };
        buyer.score = earned;
        await buyer.save();

        const totalPossible =
          allTests.reduce((s, t) => s + (t.score || 1), 0) || 1;
        const percent = Math.round((earned / totalPossible) * 1000) / 10;

        await bot.answerCallbackQuery(qid, {
          text: "✅ Variant test natijalari saqlandi.",
          show_alert: false,
        });

        try {
          await sendClosedTestLink(userId);
        } catch (e) {
          console.error("send URL (finish_test) error:", e?.message || e);
        }
        return;
      }
    } catch (err) {
      console.error("callback_query error:", err);
      try {
        await bot.answerCallbackQuery(query.id, {
          text: "Xatolik yuz berdi.",
          show_alert: true,
        });
      } catch (e) {}
    }
  });

  // ====== /testni_tugatish (admin — server-side final processing & bonuses & degrees) ======
  bot.onText(/\/testni_tugatish/, async (msg) => {
    const adminId = msg.chat.id;
    if (!isAdmin(adminId))
      return bot.sendMessage(adminId, "❌ Bu buyruq faqat adminlar uchun!");

    const buyers = await Buyers.find({}).lean();
    if (!buyers.length)
      return bot.sendMessage(adminId, "🚫 Buyers mavjud emas.");

    // 1) hammani finished = true (test ishlay olmaydi)
    await Buyers.updateMany({}, { $set: { finished: true } });

    // 2) eng ko'p xato qilgan userni topish
    const worstBuyer = buyers.reduce(
      (max, b) =>
        b.wrongAnswers.length > (max?.wrongAnswers.length || 0) ? b : max,
      null
    );
    if (worstBuyer && (worstBuyer.wrongAnswers || []).length) {
      const worstMistakes = worstBuyer.wrongAnswers;
      // 3) har bir mistake uchun nechta user xato qilganini tekshir
      for (const mistake of worstMistakes) {
        const wrongCount = buyers.filter((b) =>
          (b.wrongAnswers || []).includes(mistake)
        ).length;
        const percentWrong = (wrongCount / buyers.length) * 100;

        if (percentWrong >= 90) {
          // qolgan 10%ga +0.5 ball
          for (const b of buyers) {
            if (!(b.wrongAnswers || []).includes(mistake)) {
              await Buyers.updateOne(
                { userId: b.userId },
                { $inc: { score: 0.5 } }
              );
            }
          }
        }
      }
    }

    // 4) ballarni yangilab (DBda hozirgi balllar) hamma userlarga degree va yakuniy natijani yuborish
    const allTests = await Tests.find().lean();
    const allCloseTests = await CloseTests.find().lean();
    const totalPossibleVariants = allTests.reduce(
      (s, t) => s + (t.score || 1),
      0
    );
    const totalPossibleClosed = allCloseTests.reduce(
      (s, t) => s + (t.answerA?.score || 0) + (t.answerB?.score || 0),
      0
    );
    const totalPossible = totalPossibleVariants + totalPossibleClosed || 1;

    function getDegree(percent) {
      if (percent < 70) return "F";
      if (percent < 75) return "C";
      if (percent < 83) return "C+";
      if (percent < 91) return "B";
      if (percent < 99) return "B+";
      if (percent < 100) return "A";
      return "A+";
    }

    const updatedBuyers = await Buyers.find({}).lean();
    for (const b of updatedBuyers) {
      const percent = (b.score / totalPossible) * 100;
      const degree = getDegree(percent);
      await Buyers.updateOne({ userId: b.userId }, { $set: { degree } });
      try {
        const chat = await bot.getChat(b.userId);
        const name = chat.first_name || chat.username || "—";
        const correctList =
          (b.correctAnswers || []).length > 0
            ? `✅ To'g'ri: ${(b.correctAnswers || []).join(", ")}`
            : "";
        const wrongList =
          (b.wrongAnswers || []).length > 0
            ? `❌ Xato: ${(b.wrongAnswers || []).join(", ")}`
            : "";

        let finalMessage =
          `📊 Yakuniy natijangiz (variant + yopiq):\n` +
          `👤 ${name}\n` +
          `🆔 ${b.userId}\n` +
          `⭐ Ball: ${b.score.toFixed(1)}/${totalPossible.toFixed(1)}\n` +
          `📈 Foiz: ${percent.toFixed(2)}%\n` +
          `🎓 Daraja: ${degree}`;

        if (correctList || wrongList) {
          finalMessage +=
            "\n\n" + [correctList, wrongList].filter(Boolean).join("\n");
        }

        await bot.sendMessage(b.userId, finalMessage);
      } catch (e) {
        console.log("push failed to", b.userId, e?.message || e);
      }
    }

    return bot.sendMessage(
      adminId,
      "✅ Test yakunlandi, bonuslar qo‘llandi va hammaga natija yuborildi."
    );
  });

  // /ishtirokchilarnio'chirish (renamed from /deletebuyers)
  bot.onText(/\/ishtirokchilarnio'chirish/, async (msg) => {
    const adminId = msg.chat.id;
    if (!isAdmin(adminId))
      return bot.sendMessage(adminId, "❌ Bu buyruq faqat adminlar uchun");
    await Buyers.deleteMany({});
    return bot.sendMessage(adminId, "🗑️ Barcha buyers o‘chirildi");
  });

  // /testlarnio'chirish (renamed from /deletetests)
  bot.onText(/\/testlarnio'chirish/, async (msg) => {
    const adminId = msg.chat.id;
    if (!isAdmin(adminId))
      return bot.sendMessage(adminId, "❌ Bu buyruq faqat adminlar uchun");
    await Tests.deleteMany({});
    return bot.sendMessage(adminId, "🗑️ Barcha testlar o‘chirildi");
  });
  // === show users/buyers/testing utilities ===

  // === sendtoall (text + media/forward) ===
  async function sendToAll(contentFn) {
    const usersDoc = await Users.findOne();
    if (!usersDoc || !usersDoc.ids.length) return;
    for (const uid of usersDoc.ids) {
      try {
        await contentFn(uid);
      } catch {}
    }
  }

  bot.onText(/\/sendtoall (.+)/, async (msg, match) => {
    if (!isRegularAdmin(msg.chat.id)) return;
    await sendToAll((uid) => bot.sendMessage(uid, match[1]));
    bot.sendMessage(msg.chat.id, "📢 Xabar yuborildi!");
  });

  // 2) media/forward yuborish
  bot.on("message", async (msg) => {
    if (!isRegularAdmin(msg.chat.id)) return;
    if (msg.text && msg.text.startsWith("/")) return; // komandalarni tashlab ket

    if (
      msg.photo ||
      msg.video ||
      msg.document ||
      msg.audio ||
      msg.voice ||
      msg.caption ||
      msg.text
    ) {
      await sendToAll((uid) =>
        bot.copyMessage(uid, msg.chat.id, msg.message_id)
      );
      bot.sendMessage(msg.chat.id, "✅ Xabar yuborildi!");
    }
  });

  // ====== graceful shutdown ======
  process.on("SIGINT", async () => {
    // try {
    //   await userConn.close();
    // } catch (e) {}
    try {
      await buyerConn.close();
    } catch (e) {}
    try {
      await testConn.close();
    } catch (e) {}
    console.log("Shutting down");
    process.exit(0);
  });
  console.log("Bot ishga tushdi");

  // ====== Web App (MathLive input form) ======
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Express route
  app.get("/", async (req, res) => {
    const tests = await CloseTests.find().sort({ number: 1 }).lean();

    // Masalan, testni boshlagan foydalanuvchini topamiz
    // (siz buni session, query yoki db orqali olishingiz mumkin)
    const buyer = await Buyers.findOne().lean(); // test uchun bitta buyer

    const userId = buyer?.userId || 0; // agar bo'lmasa 0

    const inputs = tests
      .map(
        (t) =>
          `<div style="margin:12px 0; padding: 12px; border: 1px solid #e5e7eb; border-radius: 8px;">
          <label style="font-weight: bold; display: block; margin-bottom: 8px;">❓ ${t.number}-savol</label>
          <div style="display: flex; gap: 12px; flex-wrap: wrap;">
            <div style="flex: 1; min-width: 200px;">
              <label style="display: block; margin-bottom: 4px; font-weight: 500;">A javob:</label>
              <math-field style="display:block;border:1px solid #ccc;border-radius:8px;padding:8px;" id="q_${t.number}_a" virtual-keyboard-mode="onfocus"></math-field>
            </div>
            <div style="flex: 1; min-width: 200px;">
              <label style="display: block; margin-bottom: 4px; font-weight: 500;">B javob:</label>
              <math-field style="display:block;border:1px solid #ccc;border-radius:8px;padding:8px;" id="q_${t.number}_b" virtual-keyboard-mode="onfocus"></math-field>
            </div>
          </div>
        </div>`
      )
      .join("");

    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Yopiq Test</title>
    <script type="module" src="https://unpkg.com/mathlive?module"></script>
    <style>
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 20px; }
      button { padding: 10px 16px; border-radius: 8px; border: 0; background:#2563eb; color:#fff; cursor:pointer; }
      button:disabled { opacity: .6; cursor: not-allowed; }
      .row { display:flex; gap: 8px; align-items:center; flex-wrap: wrap; }
      .card { padding: 16px; border: 1px solid #e5e7eb; border-radius: 12px; margin-bottom: 16px; }
    </style>
  </head>
  <body>
    <h1 style="text-align: center;">Yopiq test</h1>
    <div id="form" class="card">
      ${inputs || "<p>Hozircha yopiq testlar yo'q.</p>"}
      <div class="row">
        <input id="userId" type="number" value="${userId}" readonly style="padding:8px;border:1px solid #e5e7eb;border-radius:8px;background:#f3f4f6;" />
        <button id="check">Tekshirish</button>
      </div>
      <p id="msg"></p>
    </div>
    <script>
      async function submit() {
        const btn = document.getElementById('check');
        btn.disabled = true;
        const userId = Number(document.getElementById('userId').value || '0');
        if (!userId) { document.getElementById('msg').textContent = 'UserId topilmadi'; btn.disabled = false; return; }
        const fields = Array.from(document.querySelectorAll('math-field[id^="q_"]'));
        const answers = {};
        for (const el of fields) {
          const idParts = el.id.replace('q_','').split('_');
          const qn = Number(idParts[0]);
          const answerType = idParts[1] || 'a';
          if (!answers[qn]) answers[qn] = {};
          answers[qn][answerType] = el.value.trim();
        }
        const res = await fetch('/api/submit', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ userId, answers }) });
        const data = await res.json();
        document.getElementById('msg').textContent = data.message || 'OK';
        btn.disabled = false;
      }
      document.getElementById('check').addEventListener('click', submit);
    </script>
  </body>
</html>`;

    res.send(html);
  });

  // API: submit answers and update buyer profile
  app.post("/api/submit", async (req, res) => {
    try {
      const userId = Number(req.body?.userId);
      const answers = req.body?.answers || {};
      if (!Number.isFinite(userId))
        return res.status(400).json({ message: "userId noto'g'ri" });

      const tests = await CloseTests.find().sort({ number: 1 }).lean();
      if (!tests.length)
        return res.status(400).json({ message: "Yopiq testlar topilmadi" });

      const buyer = await Buyers.findOne({ userId });
      if (!buyer) return res.status(404).json({ message: "Buyer topilmadi" });

      // 🚫 Agar allaqachon tugatgan bo‘lsa
      if (buyer.closeTestFinished) {
        return res.status(400).json({ message: "⚠️ Siz testni tugatgansiz" });
      }

      let correct = 0;
      let wrong = 0;
      let earned = 0;
      const correctQuestions = [];
      const wrongQuestions = [];

      for (const t of tests) {
        const qNum = t.number;
        const userAnswers = answers[qNum] || {};
        const pickedA = String(userAnswers.a ?? "").trim();
        const pickedB = String(userAnswers.b ?? "").trim();

        const expectedA = String(t.answerA?.value ?? "").trim();
        const expectedB = String(t.answerB?.value ?? "").trim();

        const isCorrectA = pickedA && expectedA && pickedA === expectedA;
        const isCorrectB = pickedB && expectedB && pickedB === expectedB;

        let questionEarned = 0;
        let questionCorrect = 0;

        if (isCorrectA) {
          questionEarned += t.answerA?.score || 0;
          questionCorrect += 1;
        }
        if (isCorrectB) {
          questionEarned += t.answerB?.score || 0;
          questionCorrect += 1;
        }

        if (questionCorrect > 0) {
          correct += questionCorrect;
          earned += questionEarned;
          if (questionCorrect === 2) {
            correctQuestions.push(qNum);
          } else {
            correctQuestions.push(`${qNum} (qisman)`);
          }
        } else {
          wrong += 1;
          wrongQuestions.push(qNum);
        }
      }

      const prevCorrect = Array.isArray(buyer.correctAnswers)
        ? buyer.correctAnswers
        : [];
      const prevWrong = Array.isArray(buyer.wrongAnswers)
        ? buyer.wrongAnswers
        : [];
      buyer.correctAnswers = [...prevCorrect, ...correctQuestions];
      buyer.wrongAnswers = [...prevWrong, ...wrongQuestions];
      buyer.score = (buyer.score || 0) + earned;

      // ✅ Yopiq test tugallangan deb belgilash
      buyer.closeTestFinished = true;

      await buyer.save();

      const totalPossible =
        tests.reduce(
          (s, t) => s + (t.answerA?.score || 0) + (t.answerB?.score || 0),
          0
        ) || 1;
      const percent = Math.round((earned / totalPossible) * 1000) / 10;

      // Send results summary to buyer in Telegram for closed tests
      try {
        // Overall totals (Option tests + Close tests)
        const allVariantTests = await Tests.find().lean();
        const totalPossibleVariants = allVariantTests.reduce(
          (s, t) => s + (t.score || 1),
          0
        );
        const totalPossibleClose = tests.reduce(
          (s, t) => s + (t.answerA?.score || 0) + (t.answerB?.score || 0),
          0
        );
        const totalPossibleOverall =
          totalPossibleVariants + totalPossibleClose || 1;
        const earnedOverall = buyer.score || 0; // already cumulative
        const percentOverall =
          Math.round((earnedOverall / totalPossibleOverall) * 1000) / 10;

        const overall =
          `📊 Umumiy natija (variant + yopiq)\n` +
          `🎯 Jami ball: ${earnedOverall.toFixed(
            1
          )}/${totalPossibleOverall.toFixed(1)}\n` +
          `❌ Jami xato: ${(buyer.wrongAnswers || []).length}\n` +
          `✅ Jami to'g'ri: ${(buyer.correctAnswers || []).length}\n` +
          `📈 Umumiy foiz: ${percentOverall}%`;

        await bot.sendMessage(userId, overall);
      } catch (e) {
        console.error("send closed-test results error:", e?.message || e);
      }

      return res.json({
        message:
          "✅ Yopiq test natijalari saqlandi va foydalanuvchiga yuborildi.",
        correct,
        wrong,
        earned,
        totalPossible,
        percent,
      });
    } catch (e) {
      console.error("/api/submit error:", e);
      return res.status(500).json({ message: "Server xatosi" });
    }
  });

  const WEB_PORT = Number(process.env.WEB_PORT || 8080);
  app.listen(WEB_PORT, () => console.log(`🌐 Web app running on :${WEB_PORT}`));
})();
