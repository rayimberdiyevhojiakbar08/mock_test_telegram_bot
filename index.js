import TelegramBot from "node-telegram-bot-api";
import mongoose from "mongoose";
import dotenv from "dotenv";

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
const isRegularAdmin = (id) => ADMINS.includes(id) && Number(id) !== MAIN_ADMIN_ID;

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

  return { buyerConn, testConn };
}

// === INIT ===
(async () => {
  const { buyerConn, testConn } = await connectDBs();

  // ====== Schemas ======
  const usersSchema = new mongoose.Schema({
    ids: { type: [Number], default: [] },
  });

  // Global test progress flag to prevent duplicate starts
  let testsInProgress = false;

  // Shared: show users count
  async function handleShowUsers(adminId) {
    const doc = await Users.findOne();
    return bot.sendMessage(adminId, `👥 Userlar soni: ${doc?.ids?.length || 0}`);
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
      rows.push(`👤 ${name} |🆔 ${b.userId} |🎯 ${b.score || 0} |🎓 ${degree}`);
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
      const percent = Math.round((b.score / totalPossible) * 1000) / 10;
      lines.push(
        `${name} |🎯${b.score} |📈${percent}%|🎓${b.degree}`
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
    correctAnswers: { type: [Number], default: [] },
    wrongAnswers: { type: [Number], default: [] },
    score: { type: Number, default: 0 },
    finished: { type: Boolean, default: false },
    degree: { type: String, default: "—" },
    lastAnswer: {
      qNumber: { type: Number, default: null },
      choiceIdx: { type: Number, default: null },
    },
  });
  const testsSchema = new mongoose.Schema({
    number: { type: Number, unique: true },
    question: { type: String, default: "" },
    image: { type: String, default: null },
    options: { type: [String], default: ["A", "B", "C", "D"] },
    answer: { type: String, required: true },
    score: { type: Number, default: 1 },
  });
  // Models
  const Users = mongoose.model("Users", usersSchema); // default conn
  const Buyers = buyerConn.model("Buyer", BuyersSchema);
  const Tests = testConn.model("Test", testsSchema);

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
          [{ text: "/testlarnio'chirish" }, { text: "/ishtirokchilarnio'chirish" }],
          [{ text: "/testyaratish" }, { text: "/testniboshlash" }],
          [{ text: "/testni_tugatish" }],
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
        if (err?.code === 11000 || (err?.message && err.message.includes("duplicate"))) {
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
      `🛠 Test yaratish boshlandi.\n1️⃣ Rasm yuborish (/skip rasm bo'lmasa)\n2️⃣ Savol matni\n3️⃣ Savol Variantlari\n4️⃣ To'g'ri javob(A,B,C...)\n5️⃣ Ball\nTugatgach /testyaratishni_tugat yozing.`
    );
  });

  // Admin message handler for test creation (only when session exists)
  bot.on("message", async (msg) => {
    const adminId = msg.chat.id;
    if (!isMainAdmin(adminId)) return;

    const session = creatingTestSessions[adminId];
    if (!session) return; // only handle messages if session exists

    const step = session.step;

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
              question: q.question,
              image: q.image,
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
        `✅ Savol saqlandi!\n${totalTests} ta test bor.`
      );

      delete creatingTestSessions[adminId];
      return;
    }

    // Step 1: rasm yoki /skip
    if (step === 1) {
      if (msg.photo) {
        session.currentQuestion = {
          image: msg.photo[msg.photo.length - 1].file_id,
        };
        session.step = 2;
        await bot.sendMessage(
          adminId,
          "✅ Rasm qabul qilindi. Endi savol matnini yuboring:"
        );
        return;
      } else if (msg.text && msg.text.trim() === "/skip") {
        session.currentQuestion = { image: null };
        session.step = 2;
        await bot.sendMessage(
          adminId,
          "✅ Rasm o‘tkazildi. Savol matnini yuboring:"
        );
        return;
      } else {
        return bot.sendMessage(adminId, "Rasm yuboring yoki /skip yozing.");
      }
    }

    // Step 2: Savol matni
    if (step === 2 && msg.text) {
      session.currentQuestion.question = msg.text.trim();
      session.step = 3;
      await bot.sendMessage(adminId, "🅰️ Variantlarni yuboring:");
      return;
    }

    // Step 3: Variantlar
    if (step === 3 && msg.text) {
      const opts = msg.text
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      if (opts.length < 2)
        return bot.sendMessage(adminId, "⚠️ Kamida 2 ta variant kiriting.");

      session.currentQuestion.options = opts;
      session.step = 4;
      await bot.sendMessage(
        adminId,
        "✅ To‘g‘ri javobni kiriting (masalan: A):"
      );
      return;
    }

    // Step 4: To'g'ri javob
    if (step === 4 && msg.text) {
      session.currentQuestion.answer = msg.text.trim().toUpperCase();
      session.step = 5;
      await bot.sendMessage(adminId, "🎯 Ballni kiriting (raqam):");
      return;
    }

    // Step 5: Ball
    if (step === 5 && msg.text) {
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
        "➕ Savol qo‘shildi. Yana rasm yuboring yoki /testyaratishni_tugat yozing."
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
        let message = `#️⃣ Test №${t.number}\n\n❓ Savol: ${t.question}\n\n`;

        // Variantlarni chiqaramiz
        t.options.forEach((opt, idx) => {
          const letter = String.fromCharCode(65 + idx); // 65 = 'A'
          message += `${letter}) ${opt}\n`;
        });

        message += `\n✅ To‘g‘ri javob: ${t.answer}\n`;
        message += `🏆 Ball: ${t.score}`;

        if (t.image) {
          await bot.sendPhoto(adminId, t.image, { caption: message });
        } else {
          await bot.sendMessage(adminId, message);
        }
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
      if (buyer.finished) continue; // agar tugatilgan bo'lsa o'tkazish
      for (let i = 0; i < tests.length; i++) {
        const t = tests[i];
        const isLast = i === tests.length - 1;

        // variantlar (A,B,C,...) bir qator davomida
        const optsRow = t.options.map((opt, idx) => ({
          text: String.fromCharCode(65 + idx),
          callback_data: `pick_${t.number}_${idx}`,
        }));

        // confirm tugmasi va agar oxirgi savol bo'lsa finish ham qo'shiladi
        const keyboard = {
          inline_keyboard: [
            optsRow,
            [{ text: "✅ Tasdiqlash", callback_data: `confirm_${t.number}` }],
          ],
        };
        if (isLast)
          keyboard.inline_keyboard.push([
            { text: "🏁 Testni tugatish", callback_data: "finish_test" },
          ]);

        try {
          if (t.image) {
            await bot.sendPhoto(buyer.userId, t.image, {
              caption:
                `❓ ${t.number}-savol:\n${t.question}\n\n` +
                t.options
                  .map((o, idx) => `${String.fromCharCode(65 + idx)}) ${o}`)
                  .join("\n"),
              reply_markup: keyboard,
            });
          } else {
            await bot.sendMessage(
              buyer.userId,
              `❓ ${t.number}-savol:\n${t.question}\n\n` +
                t.options
                  .map((o, idx) => `${String.fromCharCode(65 + idx)}) ${o}`)
                  .join("\n"),
              { reply_markup: keyboard }
            );
          }
        } catch (e) {
          console.log(`send to ${buyer.userId} failed:`, e?.message || e);
        }

        await sleep(RATE_LIMIT_DELAY);
      }
    }
    await bot.sendMessage(
      adminId,
      `✅ Testlar yuborildi (${buyers.length} buyers).`
    );
  }

  bot.onText(/\/testniboshlash/, async (msg) => {
    const adminId = msg.chat.id;
    if (!isAdmin(adminId))
      return bot.sendMessage(adminId, "❌ Bu buyruq faqat adminlar uchun!");
    await sendAllTestsToBuyers(adminId);
  });

  // ====== callback_query: pick / confirm / finish_test ======
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

      // 1) variant tanlash: pick_<qNumber>_<idx>
      if (data.startsWith("pick_")) {
        const parts = data.split("_");
        const qNumber = Number(parts[1]);
        const choiceIdx = Number(parts[2]);

        // agar oldin javob bergan bo'lsa
        if (
          (buyer.correctAnswers || []).includes(qNumber) ||
          (buyer.wrongAnswers || []).includes(qNumber)
        ) {
          return bot.answerCallbackQuery(qid, {
            text: "⚠️ Bu savolga allaqachon javob bergansiz.",
            show_alert: false,
          });
        }

        // Saqlaymiz — lastAnswerga
        buyer.lastAnswer = { qNumber, choiceIdx };
        await buyer.save();

        return bot.answerCallbackQuery(qid, {
          text: `📌 Siz ${String.fromCharCode(
            65 + choiceIdx
          )} variantini tanladingiz. Endi "Tasdiqlash" tugmasini bosing.`,
          show_alert: true,
        });
      }

      // 2) tasdiqlash: confirm_<qNumber>
      if (data.startsWith("confirm_")) {
        const parts = data.split("_");
        const qNumber = Number(parts[1]);

        if (!buyer.lastAnswer || buyer.lastAnswer.qNumber !== qNumber) {
          return bot.answerCallbackQuery(qid, {
            text: "⚠️ Avval variantni tanlang.",
            show_alert: true,
          });
        }

        const choiceIdx = buyer.lastAnswer.choiceIdx;
        const test = await Tests.findOne({ number: qNumber }).lean();
        if (!test)
          return bot.answerCallbackQuery(qid, {
            text: "⚠️ Savol topilmadi.",
            show_alert: true,
          });

        const correctIdx = parseCorrectIndex(test);
        const isCorrect = !isNaN(correctIdx) ? choiceIdx === correctIdx : false;

        if (isCorrect) {
          // duplicate tekshiruvi
          if (!buyer.correctAnswers.includes(qNumber)) {
            buyer.correctAnswers.push(qNumber);
            buyer.score += test.score || 1;
          }
          await buyer.save();
          await bot.answerCallbackQuery(qid, {
            text: "✅ To‘g‘ri javob!",
            show_alert: false,
          });
        } else {
          if (!buyer.wrongAnswers.includes(qNumber))
            buyer.wrongAnswers.push(qNumber);
          await buyer.save();
          await bot.answerCallbackQuery(qid, {
            text: "❌ Noto‘g‘ri javob.",
            show_alert: false,
          });
        }

        // clear lastAnswer
        buyer.lastAnswer = { qNumber: null, choiceIdx: null };
        await buyer.save();
        return;
      }

      // 3) testni tugatish (foydalanuvchi tugatishi uchun: oxirgi savolda chiqadi)
      if (data === "finish_test") {
        // agar lastAnswer bor va oxirgi savol bo'yicha tasdiqlanmagan bo'lsa, biz uni avtomatik confirm qilishga urinib ko'ramiz
        if (buyer.lastAnswer && buyer.lastAnswer.qNumber) {
          const qNumber = buyer.lastAnswer.qNumber;
          const choiceIdx = buyer.lastAnswer.choiceIdx;
          const test = await Tests.findOne({ number: qNumber }).lean();
          if (test) {
            const correctIdx = parseCorrectIndex(test);
            const isCorrect = !isNaN(correctIdx)
              ? choiceIdx === correctIdx
              : false;
            if (isCorrect) {
              if (!buyer.correctAnswers.includes(qNumber)) {
                buyer.correctAnswers.push(qNumber);
                buyer.score += test.score || 1;
              }
            } else {
              if (!buyer.wrongAnswers.includes(qNumber))
                buyer.wrongAnswers.push(qNumber);
            }
          }
        }

        buyer.finished = true;
        buyer.lastAnswer = { qNumber: null, choiceIdx: null };
        await buyer.save();

        // yuborish — yakuniy xabar
        const allTests = await Tests.find().lean();
        const totalPossible =
          allTests.reduce((s, t) => s + (t.score || 1), 0) || 1;
        const correctCount = (buyer.correctAnswers || []).length;
        const wrongCount = (buyer.wrongAnswers || []).length;
        const percent = Math.round((buyer.score / totalPossible) * 1000) / 10;

        await bot.answerCallbackQuery(qid, {
          text: "✅ Test tugatildi.",
          show_alert: false,
        });
        await bot.sendMessage(
          userId,
          `📊 Test yakunlandi!\n✅ To'g'ri: ${correctCount}\n❌ Xato: ${wrongCount}\n🎯 Ball: ${buyer.score}/${totalPossible}\n📈 Foiz: ${percent}%`
        );
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
    const totalPossible = allTests.reduce((s, t) => s + (t.score || 1), 0) || 1;

    function getDegree(percent) {
      if (percent < 55) return "F";
      if (percent < 60) return "C";
      if (percent < 70) return "C+";
      if (percent < 75) return "B";
      if (percent < 85) return "B+";
      if (percent < 90) return "A";
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
        await bot.sendMessage(
          b.userId,
          `📊 Yakuniy natijangiz:\n👤 ${name}\n🆔 ${b.userId}\n⭐ Ball: ${
            b.score
          }/${totalPossible}\n📈 Foiz: ${percent.toFixed(
            2
          )}%\n🎓 Daraja: ${degree}`
        );
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
})();
