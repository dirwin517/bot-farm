import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { Supervisor } from "../src/supervisor.mjs"
import { startServer } from "../src/server.mjs"

const require = createRequire("/home/claude/.npm-global/lib/node_modules/@mermaid-js/mermaid-cli/")
const puppeteer = require("puppeteer")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const mock = spawn(process.execPath, [new URL("./mock-opencode.mjs", import.meta.url).pathname], { stdio: "ignore" })
await sleep(700)
const sup = new Supervisor({ url: "http://127.0.0.1:4096", statePath: "/tmp/botfarm-shot-" + Date.now() + ".json", registryPath: "/tmp/botfarm-reg-" + Math.random().toString(36).slice(2) + ".json" })
await sup.start()
const { url } = startServer({ supervisor: sup, port: 4799 })
// the board only shows sessions botfarm manages, so adopt the mock's two first
await sup.adopt(sup.unmanaged.map((x) => x.id))
await sleep(2500)
// light the mesh up so the screenshot shows handles, mail and policy controls
const [a, b] = sup.store.list()
await sup.setPolicy(a.id, { talk: "open", spawn: true })
await sup.setPolicy(b.id, { talk: "open" })
await sup.mesh.send(a, b.handle, "The auth middleware I touched also gates /health — check before you change it.")
for (const s2 of [a, b]) await sup.setPolicy(s2.id, { rooms: "create" })
const room = sup.rooms.create({ name: "auth refactor", topic: "Splitting session auth out of the monolith", members: [a, b] })
await sup.rooms.post(room, a, "Moved the token parser to packages/auth. Nothing else touched yet.")
await sup.rooms.post(room, null, `Ship that first, leave the cookie bug to @${b.handle}`)
await sleep(1200)

const browser = await puppeteer.launch({ args: ["--no-sandbox"], executablePath: process.env.CHROME_PATH || undefined })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 980, deviceScaleFactor: 2 })
const errors = []
page.on("pageerror", (e) => errors.push(String(e)))
page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
await page.goto(url, { waitUntil: "domcontentloaded" })
await sleep(2500)
await page.screenshot({ path: "/tmp/dash.png" })

const cards = await page.$$eval(".pod", (els) =>
  els.map((e) => ({
    status: e.dataset.status,
    name: e.querySelector(".name").textContent,
    tpm: e.querySelector(".tpm").textContent,
    paths: e.querySelectorAll("svg.spark path").length,
  })),
)
console.log("cards:", JSON.stringify(cards))
console.log("errors:", errors.slice(0, 5))

await page.click(".navitem[data-k=\"room\"]")
await sleep(1000)
await page.screenshot({ path: "/tmp/room.png" })
console.log("room view:", await page.$$eval(".chat .turn .m", (e) => e.map((x) => x.textContent)))
await page.click("#rm-close")
await sleep(400)
await page.click(".pod .open")
await sleep(1200)
await page.screenshot({ path: "/tmp/inspector.png" })
console.log("side sections:", await page.$$eval(".modal .side h3", (e) => e.map((x) => x.textContent)))
console.log("errors2:", errors.slice(0, 5))

await browser.close()
await sup.stop()
mock.kill()
process.exit(0)
