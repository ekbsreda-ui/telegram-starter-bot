
import fs from "node:fs/promises"
import path from "node:path"

// Настройки бота
const ADMIN_ID = 886539766
const DB_DIR = "/data/storage"
const DB_FILE = path.join(DB_DIR, "entries.json")
const MAX_ENTRIES = 20

// Состояния администратора
const states = new Map()

// ================================
// БАЗА ДАННЫХ
// ================================

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

// ================================
// ПРОВЕРКА АДМИНИСТРАТОРА
// ================================

function isAdmin(ctx) {
  return ctx.from?.id === ADMIN_ID
}

// ================================
// ПОЛУЧЕНИЕ МАТЕРИАЛА
// ================================

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

  // Документы, PDF и MP3 как файл
  if (msg.document) {
    return {
      type: "document",
      fileId: msg.document.file_id,
      caption: msg.caption || ""
    }
  }

  // Обычный текст
  if (msg.text && !msg.text.startsWith("/")) {
    return {
      type: "text",
      text: msg.text
    }
  }

  return null
}

// ================================
// ОТПРАВКА СОХРАНЁННОГО МАТЕРИАЛА
// ================================

async function sendEntry(ctx, entry) {

  // Фотография
  if (entry.type === "photo") {
    return ctx.replyWithPhoto(entry.fileId, {
      caption: entry.caption || undefined
    })
  }

  // Музыка и MP3
  if (entry.type === "audio") {
    return ctx.replyWithAudio(entry.fileId, {
      caption: entry.caption || undefined
    })
  }

  // Голосовое сообщение
  if (entry.type === "voice") {
    return ctx.replyWithVoice(entry.fileId)
  }

  // Документ и PDF
  if (entry.type === "document") {
    return ctx.replyWithDocument(entry.fileId, {
      caption: entry.caption || undefined
    })
  }

  // Текст
  if (entry.type === "text") {
    return ctx.reply(entry.text)
  }

  return ctx.reply("Неизвестный формат материала.")
}

// ================================
// РЕГИСТРАЦИЯ КОМАНД
// ================================

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
      "Отправь ключевое слово для поиска."
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

    if (keys.length === 0) {
      return ctx.reply("База пока пустая.")
    }

    await ctx.reply(
      "Сохранённые слова:\n\n" +
      keys.map((key, index) =>
        `${index + 1}. ${key}`
      ).join("\n")
    )
  })

  // ================================
  // ОБРАБОТКА СООБЩЕНИЙ
  // ================================

  bot.on("message", async (ctx) => {

    const userId = ctx.from?.id
    const msg = ctx.message

    if (!userId) return

    const state = states.get(userId)

    // ================================
    // ДЕЙСТВИЯ АДМИНИСТРАТОРА
    // ================================

    if (isAdmin(ctx) && state) {

      // ДОБАВЛЕНИЕ И ИЗМЕНЕНИЕ КЛЮЧЕВОГО СЛОВА
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

      // УДАЛЕНИЕ ЗАПИСИ
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

      // СОХРАНЕНИЕ МАТЕРИАЛА
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

    // ================================
    // ПОИСК ИНФОРМАЦИИ
    // ================================

    if (ctx.chat.type !== "private") return

    if (!msg.text || msg.text.startsWith("/")) return

    const key = msg.text.trim().toLowerCase()

    if (!key) return

    const db = await loadDB()

    if (db[key]) {
      return sendEntry(ctx, db[key])
    }

    return ctx.reply(
      "Информации по этому объекту нет."
    )
  })

  // ================================
  // ОБРАБОТКА ОШИБОК
  // ================================

  bot.catch((err) => {
    console.error(
      "[commands] error:",
      err.error ?? err
    )
  })
}
