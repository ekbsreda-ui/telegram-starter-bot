
import fs from "node:fs/promises"
import path from "node:path"

// =====================================
// НАСТРОЙКИ
// =====================================

const ADMIN_ID = 886539766
const DB_DIR = "/data/storage"
const DB_FILE = path.join(DB_DIR, "entries.json")
const MAX_ENTRIES = 20

const states = new Map()

// =====================================
// БАЗА ДАННЫХ
// =====================================

async function loadDB() {
  try {
    const data = await fs.readFile(DB_FILE, "utf8")
    return JSON.parse(data)
  } catch (err) {
    if (err.code === "ENOENT") return {}
    throw err
  }
}

async function saveDB(db) {
  await fs.mkdir(DB_DIR, { recursive: true })

  const temp = DB_FILE + ".tmp"

  await fs.writeFile(
    temp,
    JSON.stringify(db, null, 2),
    "utf8"
  )

  await fs.rename(temp, DB_FILE)
}

// =====================================
// ПРОВЕРКА АДМИНИСТРАТОРА
// =====================================

function isAdmin(ctx) {
  return ctx.from?.id === ADMIN_ID
}

// =====================================
// НОРМАЛИЗАЦИЯ СЛОВ
// =====================================

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ")
}

function getWords(text) {
  return normalize(text)
    .split(" ")
    .filter(Boolean)
}

// =====================================
// РАССТОЯНИЕ ЛЕВЕНШТЕЙНА
// =====================================

function levenshtein(a, b) {
  const first = Array.from(a)
  const second = Array.from(b)

  const dp = Array.from(
    { length: first.length + 1 },
    () => Array(second.length + 1).fill(0)
  )

  for (let i = 0; i <= first.length; i++) {
    dp[i][0] = i
  }

  for (let j = 0; j <= second.length; j++) {
    dp[0][j] = j
  }

  for (let i = 1; i <= first.length; i++) {
    for (let j = 1; j <= second.length; j++) {
      const cost =
        first[i - 1] === second[j - 1] ? 0 : 1

      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      )
    }
  }

  return dp[first.length][second.length]
}

// Сходство двух слов от 0 до 1
function wordSimilarity(a, b) {
  if (a === b) return 1

  if (!a || !b) return 0

  const distance = levenshtein(a, b)
  const maxLength = Math.max(
    Array.from(a).length,
    Array.from(b).length
  )

  return 1 - distance / maxLength
}

// =====================================
// УМНЫЙ ПОИСК
// =====================================

function calculateSimilarity(query, savedKey) {
  const q = normalize(query)
  const k = normalize(savedKey)

  if (!q || !k) return 0

  // Полное совпадение
  if (q === k) return 1

  // Совпадение одной фразы внутри другой
  if (k.includes(q) || q.includes(k)) {
    const shorter = Math.min(q.length, k.length)
    const longer = Math.max(q.length, k.length)

    return Math.max(0.75, shorter / longer)
  }

  const queryWords = getWords(q)
  const keyWords = getWords(k)

  if (!queryWords.length || !keyWords.length) {
    return 0
  }

  // Сходство каждого слова запроса со словами базы
  const queryMatches = queryWords.map(word => {
    return Math.max(
      ...keyWords.map(savedWord =>
        wordSimilarity(word, savedWord)
      )
    )
  })

  // Сходство каждого слова базы со словами запроса
  const keyMatches = keyWords.map(word => {
    return Math.max(
      ...queryWords.map(queryWord =>
        wordSimilarity(word, queryWord)
      )
    )
  })

  const recall =
    queryMatches.reduce((sum, value) => sum + value, 0) /
    queryMatches.length

  const precision =
    keyMatches.reduce((sum, value) => sum + value, 0) /
    keyMatches.length

  const f1 =
    precision + recall === 0
      ? 0
      : 2 * precision * recall / (precision + recall)

  let score = f1

  // Помогает искать коротким словом
  // длинную запись, например "надпись"
  // -> "надпись на стене".
  if (queryWords.length === 1) {
    const bestWordMatch = Math.max(
      ...keyWords.map(word =>
        wordSimilarity(queryWords[0], word)
      )
    )

    score = Math.max(score, bestWordMatch * 0.85)
  }

  return score
}

// =====================================
// ПОИСК ПОДХОДЯЩЕЙ ЗАПИСИ
// =====================================

function findMatches(query, db) {
  const normalizedQuery = normalize(query)

  // Сначала ищем точное совпадение
  const exactKey = Object.keys(db).find(
    key => normalize(key) === normalizedQuery
  )

  if (exactKey) {
    return {
      exact: true,
      matches: [{ key: exactKey, score: 1 }]
    }
  }

  // Затем ищем похожие записи
  const matches = Object.keys(db)
    .map(key => ({
      key,
      score: calculateSimilarity(query, key)
    }))
    .filter(item => item.score >= 0.52)
    .sort((a, b) => b.score - a.score)

  return {
    exact: false,
    matches
  }
}

// =====================================
// ПОЛУЧЕНИЕ МАТЕРИАЛА
// =====================================

function getContent(msg) {

  // Музыка и MP3
  if (msg.audio) {
    return {
      type: "audio",
      fileId: msg.audio.file_id,
      caption: msg.caption || ""
    }
  }

  // Голосовые сообщения
  if (msg.voice) {
    return {
      type: "voice",
      fileId: msg.voice.file_id
    }
  }

  // Фотографии
  if (msg.photo?.length) {
    return {
      type: "photo",
      fileId: msg.photo[msg.photo.length - 1].file_id,
      caption: msg.caption || ""
    }
  }

  // Документы и PDF
  if (msg.document) {
    return {
      type: "document",
      fileId: msg.document.file_id,
      caption: msg.caption || ""
    }
  }

  // Текст
  if (msg.text && !msg.text.startsWith("/")) {
    return {
      type: "text",
      text: msg.text
    }
  }

  return null
}

// =====================================
// ОТПРАВКА МАТЕРИАЛА
// =====================================

async function sendEntry(ctx, entry) {

  if (entry.type === "photo") {
    return ctx.replyWithPhoto(entry.fileId, {
      caption: entry.caption || undefined
    })
  }

  if (entry.type === "audio") {
    return ctx.replyWithAudio(entry.fileId, {
      caption: entry.caption || undefined
    })
  }

  if (entry.type === "voice") {
    return ctx.replyWithVoice(entry.fileId)
  }

  if (entry.type === "document") {
    return ctx.replyWithDocument(entry.fileId, {
      caption: entry.caption || undefined
    })
  }

  if (entry.type === "text") {
    return ctx.reply(entry.text)
  }

  return ctx.reply("Неизвестный формат материала.")
}

// =====================================
// РЕГИСТРАЦИЯ КОМАНД
// =====================================

export function registerCommands(bot) {

  // START
  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Привет! Отправь ключевое слово, чтобы получить информацию."
    )
  })

  // HELP
  bot.command("help", async (ctx) => {

    const commands = [
      "Доступные команды:",
      "/start — начало работы",
      "/help — помощь",
      "/id — узнать свой ID",
      "",
      "Отправь ключевое слово для поиска.",
      "Я также понимаю похожие слова и небольшие опечатки."
    ]

    if (isAdmin(ctx)) {
      commands.push(
        "",
        "Команды администратора:",
        "/add — добавить запись",
        "/edit — изменить запись",
        "/delete — удалить запись",
        "/list — список записей",
        "/cancel — отменить действие"
      )
    }

    await ctx.reply(commands.join("\n"))
  })

  // ID
  bot.command("id", async (ctx) => {
    await ctx.reply(
      `Chat ID: ${ctx.chat.id}\nYour ID: ${ctx.from?.id ?? "unknown"}`
    )
  })

  // CANCEL
  bot.command("cancel", async (ctx) => {
    if (!isAdmin(ctx)) return

    states.delete(ctx.from.id)

    await ctx.reply("Действие отменено.")
  })

  // ADD
  bot.command("add", async (ctx) => {
    if (!isAdmin(ctx)) return

    states.set(ctx.from.id, {
      action: "add-key"
    })

    await ctx.reply("Отправь новое ключевое слово.")
  })

  // EDIT
  bot.command("edit", async (ctx) => {
    if (!isAdmin(ctx)) return

    states.set(ctx.from.id, {
      action: "edit-key"
    })

    await ctx.reply(
      "Отправь ключевое слово, которое нужно изменить."
    )
  })

  // DELETE
  bot.command("delete", async (ctx) => {
    if (!isAdmin(ctx)) return

    states.set(ctx.from.id, {
      action: "delete-key"
    })

    await ctx.reply("Отправь ключевое слово для удаления.")
  })

  // LIST
  bot.command("list", async (ctx) => {
    if (!isAdmin(ctx)) return

    const db = await loadDB()
    const keys = Object.keys(db)

    if (!keys.length) {
      return ctx.reply("База пока пустая.")
    }

    await ctx.reply(
      "Сохранённые слова:\n\n" +
      keys.map((key, index) =>
        `${index + 1}. ${key}`
      ).join("\n")
    )
  })

  // ===================================
  // ОБРАБОТКА СООБЩЕНИЙ
  // ===================================

  bot.on("message", async (ctx) => {

    const userId = ctx.from?.id
    const msg = ctx.message

    if (!userId) return

    const state = states.get(userId)

    // -----------------------------------
    // КОМАНДЫ И ДЕЙСТВИЯ АДМИНИСТРАТОРА
    // -----------------------------------

    if (isAdmin(ctx) && state) {

      // Добавление или изменение ключа
      if (
        state.action === "add-key" ||
        state.action === "edit-key"
      ) {

        if (!msg.text || msg.text.startsWith("/")) {
          return ctx.reply(
            "Отправь ключевое слово обычным текстом."
          )
        }

        const key = msg.text.trim().toLowerCase()

        if (!key || key.length > 64) {
          return ctx.reply(
            "Слово должно содержать от 1 до 64 символов."
          )
        }

        const db = await loadDB()

        if (state.action === "add-key") {

          if (db[key]) {
            return ctx.reply(
              "Такое слово уже существует. Используй /edit."
            )
          }

          if (Object.keys(db).length >= MAX_ENTRIES) {
            states.delete(userId)

            return ctx.reply(
              "Достигнут лимит в 20 записей."
            )
          }

          states.set(userId, {
            action: "add-content",
            key
          })

        } else {

          if (!db[key]) {
            states.delete(userId)

            return ctx.reply(
              "Такого слова нет в базе."
            )
          }

          states.set(userId, {
            action: "edit-content",
            key
          })
        }

        return ctx.reply(
          `Теперь отправь материал для слова "${key}".\n\n` +
          "Можно отправить текст, фотографию, документ, PDF, MP3 или голосовое сообщение."
        )
      }

      // Удаление записи
      if (state.action === "delete-key") {

        if (!msg.text || msg.text.startsWith("/")) {
          return ctx.reply(
            "Отправь ключевое слово обычным текстом."
          )
        }

        const key = msg.text.trim().toLowerCase()
        const db = await loadDB()

        if (!db[key]) {
          states.delete(userId)

          return ctx.reply(
            "Такого слова нет в базе."
          )
        }

        delete db[key]

        await saveDB(db)

        states.delete(userId)

        return ctx.reply(
          `Запись "${key}" удалена.`
        )
      }

      // Сохранение материала
      if (
        state.action === "add-content" ||
        state.action === "edit-content"
      ) {

        const content = getContent(msg)

        if (!content) {
          return ctx.reply(
            "Отправь текст, фотографию, документ, PDF, MP3 или голосовое сообщение."
          )
        }

        const db = await loadDB()

        db[state.key] = content

        await saveDB(db)

        states.delete(userId)

        return ctx.reply(
          `Готово! Информация для "${state.key}" сохранена.`
        )
      }
    }

    // -----------------------------------
    // ПОИСК ДЛЯ ПОЛЬЗОВАТЕЛЕЙ
    // -----------------------------------

    if (ctx.chat.type !== "private") return

    if (!msg.text || msg.text.startsWith("/")) return

    const query = msg.text.trim()

    if (!query) return

    const db = await loadDB()

    const result = findMatches(query, db)

    // Нет подходящих записей
    if (!result.matches.length) {
      return ctx.reply(
        "Информации по этому объекту нет."
      )
    }

    const best = result.matches[0]
    const second = result.matches[1]

    // Если несколько записей имеют почти одинаковое сходство,
    // не выбираем случайную
    if (
      !result.exact &&
      second &&
      best.score - second.score < 0.08
    ) {

      const options = result.matches
        .slice(0, 5)
        .map((item, index) =>
          `${index + 1}. ${item.key}`
        )
        .join("\n")

      return ctx.reply(
        "Нашёл несколько похожих записей:\n\n" +
        options +
        "\n\nОтправь точное название нужной записи."
      )
    }

    // Отправляем найденный материал
    return sendEntry(ctx, db[best.key])
  })

  // ===================================
  // ОБРАБОТКА ОШИБОК
  // ===================================

  bot.catch((err) => {
    console.error(
      "[commands] error:",
      err.error ?? err
    )
  })
}
