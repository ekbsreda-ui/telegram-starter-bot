
import { InlineKeyboard } from "grammy"
import fs from "node:fs/promises"
import path from "node:path"

const ADMIN_ID = 886539766
const DB_DIR = "/data/storage"
const DB_FILE = path.join(DB_DIR, "entries.json")
const MAX_ENTRIES = 20

const states = new Map()

async function loadDB() {
  try {
    return JSON.parse(await fs.readFile(DB_FILE, "utf8"))
  } catch (err) {
    if (err.code !== "ENOENT") throw err
    return {}
  }
}

async function saveDB(db) {
  await fs.mkdir(DB_DIR, { recursive: true })
  const temp = DB_FILE + ".tmp"
  await fs.writeFile(temp, JSON.stringify(db, null, 2), "utf8")
  await fs.rename(temp, DB_FILE)
}

function isAdmin(ctx) {
  return ctx.from?.id === ADMIN_ID
}

function getContent(msg) {

  if (msg.audio) {
    return {
      type: "audio",
      fileId: msg.audio.file_id,
      caption: msg.caption || ""
    }
  }

  if (msg.voice) {
    return {
      type: "voice",
      fileId: msg.voice.file_id
    }
  }
  if (msg.photo?.length) {
    return {
      type: "photo",
      fileId: msg.photo[msg.photo.length - 1].file_id,
      caption: msg.caption || ""
    }
  }

  if (msg.document) {
    return {
      type: "document",
      fileId: msg.document.file_id,
      caption: msg.caption || ""
    }
  }

  if (msg.text && !msg.text.startsWith("/")) {
    return { type: "text", text: msg.text }
  }

  return null
}

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
})
  }

  return ctx.reply(entry.text)
}

export function registerCommands(bot) {
  bot.command("start", (ctx) =>
    ctx.reply(
      "Привет! Отправь ключевое слово, чтобы получить информацию."
    )
  )

  bot.command("help", (ctx) => {
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

    return ctx.reply(commands.join("\n"))
  })

  bot.command("id", (ctx) =>
    ctx.reply(`Chat ID: ${ctx.chat.id}\nYour ID: ${ctx.from.id}`)
  )

  bot.command("cancel", async (ctx) => {
    if (!isAdmin(ctx)) return
    states.delete(ctx.from.id)
    await ctx.reply("Действие отменено.")
  })

  bot.command("add", async (ctx) => {
    if (!isAdmin(ctx)) return

    states.set(ctx.from.id, { action: "add-key" })
    await ctx.reply("Отправь новое ключевое слово.")
  })

  bot.command("edit", async (ctx) => {
    if (!isAdmin(ctx)) return

    states.set(ctx.from.id, { action: "edit-key" })
    await ctx.reply("Отправь ключевое слово, которое нужно изменить.")
  })

  bot.command("delete", async (ctx) => {
    if (!isAdmin(ctx)) return

    states.set(ctx.from.id, { action: "delete-key" })
    await ctx.reply("Отправь ключевое слово для удаления.")
  })

  bot.command("list", async (ctx) => {
    if (!isAdmin(ctx)) return

    const db = await loadDB()
    const keys = Object.keys(db)

    await ctx.reply(
      keys.length
        ? "Сохранённые слова:\n\n" + keys.map((k, i) => `${i + 1}. ${k}`).join("\n")
        : "База пока пустая."
    )
  })

  bot.on("message", async (ctx) => {
    const userId = ctx.from?.id
    const state = states.get(userId)

    // Обработка действий администратора
    if (isAdmin(ctx) && state) {
      const msg = ctx.message

      if (state.action === "add-key" || state.action === "edit-key") {
        if (!msg.text || msg.text.startsWith("/")) {
          return ctx.reply("Отправь ключевое слово обычным текстом.")
        }

        const key = msg.text.trim().toLowerCase()

        if (key.length > 64) {
          return ctx.reply("Слово слишком длинное. Максимум 64 символа.")
        }

        const db = await loadDB()

        if (state.action === "add-key") {
          if (db[key]) {
            return ctx.reply("Такое слово уже существует. Используй /edit.")
          }

          if (Object.keys(db).length >= MAX_ENTRIES) {
            states.delete(userId)
            return ctx.reply("Достигнут лимит в 20 записей.")
          }

          states.set(userId, { action: "add-content", key })
        } else {
          if (!db[key]) {
            states.delete(userId)
            return ctx.reply("Такого слова нет в базе.")
          }

          states.set(userId, { action: "edit-content", key })
        }

        return ctx.reply(
          `Теперь отправь материал для слова "${key}".\n\nМожно отправить текст, фотографию или документ.`
        )
      }

      if (state.action === "delete-key") {
        if (!msg.text || msg.text.startsWith("/")) {
          return ctx.reply("Отправь ключевое слово обычным текстом.")
        }

        const key = msg.text.trim().toLowerCase()
        const db = await loadDB()

        if (!db[key]) {
          states.delete(userId)
          return ctx.reply("Такого слова нет в базе.")
        }

        delete db[key]
        await saveDB(db)
        states.delete(userId)

        return ctx.reply(`Запись "${key}" удалена.`)
      }

      if (state.action === "add-content" || state.action === "edit-content") {
        const content = getContent(msg)

        if (!content) {
          return ctx.reply("Отправь текст, фотографию или документ.")
        }

        const db = await loadDB()
        db[state.key] = content

        await saveDB(db)
        states.delete(userId)

        return ctx.reply(`Готово! Информация для "${state.key}" сохранена.`)
      }
    }

    // Поиск информации для всех пользователей
    if (ctx.chat.type !== "private") return

    const text = ctx.message.text

    if (!text || text.startsWith("/")) return

    const key = text.trim().toLowerCase()
    const db = await loadDB()

    if (db[key]) {
      return sendEntry(ctx, db[key])
    }

    return ctx.reply("Информации по этому объекту нет.")
  })

  bot.catch((err) => {
    console.error("[commands] error:", err.error ?? err)
  })
}
