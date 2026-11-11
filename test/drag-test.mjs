// Drives the page in headless Chromium over CDP with real mouse and touch
// input, and checks drag-to-paint, panning, touch drawing, pinch zoom and undo.
// usage: node test/drag-test.mjs .   (needs chromium on PATH; takes several
// minutes with software WebGL)
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]
const server = http.createServer((req, res) => {
    const p = path.join(dir, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]))
    fs.readFile(p, (err, data) => {
        if (err) { res.writeHead(404); return res.end() }
        res.writeHead(200, { 'content-type': p.endsWith('.html') ? 'text/html' : 'image/png' })
        res.end(data)
    })
}).listen(0)
const port = server.address().port

const debugPort = 9300 + Math.floor(Math.random() * 500)
const chrome = spawn('chromium', ['--headless', '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--remote-debugging-port=' + debugPort, '--user-data-dir=/tmp/lp-drag-test-profile',
    '--window-size=1200,800', 'about:blank'], { stdio: 'ignore' })
let wsUrl
for (let i = 0; i < 100 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()).webSocketDebuggerUrl }
    catch (e) { await new Promise(r => setTimeout(r, 200)) }
}
const browserWs = new WebSocket(wsUrl)
await new Promise(r => browserWs.onopen = r)

let id = 0
const pending = new Map()
function rpc(ws, method, params = {}, sessionId) {
    return new Promise((done, fail) => {
        const i = ++id
        pending.set(i, { done, fail })
        ws.send(JSON.stringify({ id: i, method, params, sessionId }))
    })
}
browserWs.onmessage = m => {
    const msg = JSON.parse(m.data)
    if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id); pending.delete(msg.id)
        msg.error ? p.fail(new Error(JSON.stringify(msg.error))) : p.done(msg.result)
    }
}
const { targetId } = await rpc(browserWs, 'Target.createTarget', { url: 'about:blank' })
const { sessionId } = await rpc(browserWs, 'Target.attachToTarget', { targetId, flatten: true })
const send = (m, p) => rpc(browserWs, m, p, sessionId)
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function evaluate(expr) {
    const r = await send('Runtime.evaluate', { expression: 'window.T && (T.s = null);\n' + expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
}

let failures = 0
function check(name, ok, extra = '') {
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  (' + extra + ')' : ''))
    if (!ok) failures++
}

async function load(mobile) {
    if (mobile) {
        await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
        await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    }
    await send('Page.enable')
    await send('Runtime.enable')
    // software WebGL is slow; run the simulation slowly so the page stays responsive
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `addEventListener('DOMContentLoaded', () => { view.speed = 0.01 })` })
    await send('Page.navigate', { url: `http://localhost:${port}/index.html` })
    await sleep(2500)
    // helpers inside the page
    await evaluate(`
        window.T = {
            snap() { let s; draw_on_chip(f => { s = f.slice() }, { history : false }); return s },
            code(x, y) { T.s = T.s || T.snap(); return T.s[x*4 + y*W*4] },
            // find an empty square region near the middle of the visible board
            empty_spot(size) {
                let s = T.snap()
                let r = c.getBoundingClientRect()
                let cs = view.scale / devicePixelRatio
                let cx = Math.floor((innerWidth / 2 - r.left) / cs), cy = H - 1 - Math.floor((innerHeight * 0.6 - r.top) / cs)
                for (let rad = 0; rad < 400; rad += 4)
                    for (let ox = -rad; ox <= rad; ox += 4) for (let oy of [-rad, rad]) {
                        let x0 = cx + ox - (size >> 1), y0 = cy + oy - (size >> 1), ok = true
                        for (let x = x0 - 3; x < x0 + size + 3 && ok; x++)
                            for (let y = y0 - 3; y < y0 + size + 3 && ok; y++)
                                if (x < 0 || y < 0 || x >= W || y >= H || s[x*4 + y*W*4]) ok = false
                        if (ok) return { x : x0, y : y0 }
                    }
                return null
            },
            // client coordinates of the centre of a cell
            client(x, y) {
                let r = c.getBoundingClientRect(), cs = view.scale / devicePixelRatio
                return { x : r.left + (x + 0.5) * cs, y : r.top + (H - 1 - y + 0.5) * cs }
            },
            select(brush) { [...top_d.querySelectorAll('div')]; view.brush = brush }
        }`)
}

async function mouse(type, p, extra = {}) {
    await send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', buttons: type == 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra })
}
const client = (x, y) => evaluate(`T.client(${x}, ${y})`)
async function mouseDrag(cells, extra = {}) {
    // cells: list of [x, y] waypoints; interpolate in client space
    const pts = []
    for (const [x, y] of cells) pts.push(await client(x, y))
    await mouse('mousePressed', pts[0], extra)
    for (let i = 1; i < pts.length; i++)
        for (let k = 1; k <= 8; k++) {
            await mouse('mouseMoved', { x: pts[i-1].x + (pts[i].x - pts[i-1].x) * k / 8, y: pts[i-1].y + (pts[i].y - pts[i-1].y) * k / 8 }, extra)
            await sleep(16)
        }
    await mouse('mouseReleased', pts[pts.length - 1], extra)
    await sleep(100)
}
async function mouseClick(x, y, extra = {}) {
    const p = await client(x, y)
    await mouse('mousePressed', p, extra)
    await mouse('mouseReleased', p, extra)
    await sleep(100)
}

// ---------------- desktop, mouse ----------------
await load(false)
const spot = await evaluate('T.empty_spot(60)')
check('found empty area', !!spot, JSON.stringify(spot))
const { x: X, y: Y } = spot
await evaluate(`view.scale = 0; set_zoom(8)`)  // zoom in so cells are 8 css px
await sleep(200)
// re-centre the view on the spot
await evaluate(`(() => { let r = c.getBoundingClientRect(), cs = view.scale / devicePixelRatio
    bottom_d.scrollLeft += r.left + (${X} + 30) * cs - innerWidth / 2
    bottom_d.scrollTop += r.top + (H - 1 - ${Y} - 30) * cs - innerHeight / 2 })()`)
await sleep(200)

const undo0 = await evaluate('undo_stack.length')

// 1. horizontal wire drag with a little vertical wobble
await evaluate(`T.select('wire')`)
await mouseDrag([[X, Y + 10], [X + 8, Y + 11], [X + 20, Y + 10]])
let row = await evaluate(`(() => { let s = T.snap(), out = []; for (let x = ${X} - 2; x <= ${X} + 22; x++) out.push(s[x*4 + (${Y}+10)*W*4]); return out })()`)
let wireCode = await evaluate('things.wire.code')
check('drag draws a straight horizontal wire', row.slice(2, 23).every(v => v == wireCode) && row[0] == 0 && row[24] == 0, row.join(''))
let offRow = await evaluate(`(() => { let s = T.snap(), n = 0; for (let x = ${X}; x <= ${X} + 20; x++) for (let dy of [-1, 1]) if (s[x*4 + (${Y}+10+dy)*W*4]) n++; return n })()`)
check('wobble did not leak off the line', offRow == 0, offRow + ' stray cells')
check('whole stroke is one undo step', await evaluate('undo_stack.length') == undo0 + 1)

// 2. undo removes the whole stroke, redo brings it back
await evaluate('undo()')
check('undo removes the whole stroke', await evaluate(`[...Array(21)].every((_, i) => T.code(${X} + i, ${Y} + 10) == 0)`))
await evaluate('redo()')
check('redo restores it', await evaluate(`[...Array(21)].every((_, i) => T.code(${X} + i, ${Y} + 10) == things.wire.code)`))

// 3. L-shaped wire: right then down (screen down = y decreasing)
await mouseDrag([[X, Y + 40], [X + 15, Y + 40], [X + 15, Y + 25]])
let L = await evaluate(`(() => { let ok = true
    for (let x = ${X}; x <= ${X} + 15; x++) ok = ok && T.code(x, ${Y} + 40) == things.wire.code
    for (let y = ${Y} + 25; y <= ${Y} + 40; y++) ok = ok && T.code(${X} + 15, y) == things.wire.code
    return ok })()`)
check('dragging off the line turns a corner (L shape)', L)

// 4. drag a vertical wire across the horizontal one -> crossing
await mouseDrag([[X + 10, Y + 15], [X + 10, Y + 5]])
check('crossing a wire makes a cross gate', await evaluate(`T.code(${X} + 10, ${Y} + 10) == things.cross_gate.code`))
// dragging along the vertical wire again keeps the crossing
await mouseDrag([[X + 10, Y + 14], [X + 10, Y + 6]])
check('re-drawing over a crossing keeps it', await evaluate(`T.code(${X} + 10, ${Y} + 10) == things.cross_gate.code`))

// 5. a click (no drag) still works: place an AND gate
await evaluate(`T.select('and_gate')`)
await mouseClick(X + 40, Y + 40)
check('click still places a gate', await evaluate(`T.code(${X} + 40, ${Y} + 40) == things.and_gate.code`))
// a drag with a gate brush pans instead of placing anything
async function checkPan(name, from, to) {
    // the board point under the pointer when the drag starts should end up
    // under the pointer when it ends
    const a = await client(...from), b = await client(...to)
    const u0 = await undoCount()
    const under = await evaluate(`board_point(${a.x}, ${a.y})`)
    await mouseDrag([from, to])
    const now = await evaluate(`board_point(${b.x}, ${b.y})`)
    const err = Math.hypot(now.x - under.x, now.y - under.y)
    check(name, err < 0.5 && await undoCount() == u0, 'off by ' + err.toFixed(2) + ' cells')
}
const undoCount = () => evaluate('undo_stack.length')
await checkPan('drag with gate brush pans, board follows the mouse', [X + 50, Y + 50], [X + 40, Y + 35])
check('...and places no gate', await evaluate(`T.code(${X} + 50, ${Y} + 50) == 0`))

// the hand tool: clicks do nothing, drags pan
await evaluate(`T.select('hand')`)
let u1 = await undoCount()
await mouseClick(X + 45, Y + 45)
check('hand tool click changes nothing', await undoCount() == u1 && await evaluate(`T.code(${X} + 45, ${Y} + 45) == 0`))
await checkPan('hand tool drag pans', [X + 30, Y + 30], [X + 45, Y + 45])

// 6. a click on an existing wire still toggles it (old behaviour)
await evaluate(`T.select('wire'); view.speed = 0`)
let before = await evaluate(`T.snap()[(${X} + 5)*4 + (${Y} + 10)*W*4 + 2]`)
await mouseClick(X + 5, Y + 10)
let after = await evaluate(`T.snap()[(${X} + 5)*4 + (${Y} + 10)*W*4 + 2]`)
check('click on a wire still flips it', before != after, before + ' -> ' + after)
await evaluate('view.speed = 0.01')

// 7. shift-click line from the end of the last stroke still works
await mouseClick(X + 2, Y + 55)
await mouseClick(X + 12, Y + 55, { modifiers: 8 })
check('shift-click line still works', await evaluate(`[...Array(11)].every((_, i) => T.code(${X} + 2 + i, ${Y} + 55) == things.wire.code)`))

// 8. delete drag erases along the path, as one undo step
await evaluate(`T.select('delete')`)
let u = await evaluate('undo_stack.length')
await mouseDrag([[X + 3, Y + 10], [X + 8, Y + 10]])
check('delete drag erases along the path', await evaluate(`[3,4,5,6,7,8].every(i => T.code(${X} + i, ${Y} + 10) == 0) && T.code(${X} + 12, ${Y} + 10) == things.wire.code`))
check('delete drag is one undo step', await evaluate('undo_stack.length') == u + 1)

// 9. box drag selects a rectangle
await evaluate(`T.select('box')`)
await mouseDrag([[X, Y + 45], [X + 20, Y + 20]])
let box = await evaluate('[view.box, view.copy && view.copy.length]')
check('box drag selects a rectangle', JSON.stringify(box[0]) == JSON.stringify([X, Y + 20, X + 20, Y + 45]) && box[1] == 21 * 26 * 4, JSON.stringify(box))

// ---------------- phone, touch ----------------
await load(true)
await evaluate(`view.scale = 0; set_zoom(24)`)   // 8 css px per cell at dpr 3
await sleep(200)
const spot2 = await evaluate('T.empty_spot(40)')
const { x: PX, y: PY } = spot2
await evaluate(`(() => { let r = c.getBoundingClientRect(), cs = view.scale / devicePixelRatio
    bottom_d.scrollLeft += r.left + (${PX} + 20) * cs - innerWidth / 2
    bottom_d.scrollTop += r.top + (H - 1 - ${PY} - 20) * cs - innerHeight * 0.6 })()`)
await sleep(200)
check('viewport meta: page is phone width', await evaluate('innerWidth') == 390, await evaluate('innerWidth'))

async function touch(type, pts) {
    await send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i })) })
}
await evaluate(`T.select('wire')`)
let a = await client(PX, PY + 20), b = await client(PX + 15, PY + 20)
await touch('touchStart', [a])
for (let k = 1; k <= 10; k++) { await touch('touchMove', [{ x: a.x + (b.x - a.x) * k / 10, y: a.y + 1 }]); await sleep(16) }
await touch('touchEnd', [])
await sleep(100)
check('one-finger touch drag draws a wire', await evaluate(`[...Array(16)].every((_, i) => T.code(${PX} + i, ${PY} + 20) == things.wire.code)`))

// tap with the wire brush places a single pixel
let t = await client(PX + 5, PY + 30)
await touch('touchStart', [t]); await touch('touchEnd', []); await sleep(100)
check('tap places a wire pixel', await evaluate(`T.code(${PX} + 5, ${PY} + 30) == things.wire.code`))

// one-finger drag with the default (flip switch) tool pans
async function touchPan(name, from, to) {
    const under = await evaluate(`board_point(${from.x}, ${from.y})`)
    await touch('touchStart', [from])
    for (let k = 1; k <= 10; k++) { await touch('touchMove', [{ x: from.x + (to.x - from.x) * k / 10, y: from.y + (to.y - from.y) * k / 10 }]); await sleep(16) }
    await touch('touchEnd', [])
    await sleep(100)
    const now = await evaluate(`board_point(${to.x}, ${to.y})`)
    const err = Math.hypot(now.x - under.x, now.y - under.y)
    check(name, err < 0.5, 'off by ' + err.toFixed(2) + ' cells')
}
await evaluate(`T.select('toggle_toggle')`)
let u2 = await evaluate('undo_stack.length')
await touchPan('one-finger drag with flip-switch tool pans', { x: 200, y: 500 }, { x: 120, y: 420 })
check('...and edits nothing', await evaluate('undo_stack.length') == u2)
await evaluate(`T.select('hand')`)
await touchPan('one-finger drag with hand tool pans', { x: 150, y: 450 }, { x: 230, y: 520 })

// two fingers moving together pan, keeping the board under them
await evaluate(`T.select('wire')`)
{
    let q1 = { x: 140, y: 450 }, q2 = { x: 240, y: 450 }
    const under = await evaluate(`board_point(${(q1.x + q2.x) / 2}, ${q1.y})`)
    await touch('touchStart', [q1]); await touch('touchStart', [q1, q2])
    for (let k = 1; k <= 10; k++) { await touch('touchMove', [{ x: q1.x + 6 * k, y: q1.y - 5 * k }, { x: q2.x + 6 * k, y: q2.y - 5 * k }]); await sleep(16) }
    await touch('touchEnd', []); await sleep(100)
    const now = await evaluate(`board_point(${(q1.x + q2.x) / 2 + 60}, ${q1.y - 50})`)
    const err = Math.hypot(now.x - under.x, now.y - under.y)
    check('two-finger pan keeps the board under the fingers', err < 0.5, 'off by ' + err.toFixed(2) + ' cells')
}

// two-finger pinch: zooms, draws nothing
let snapBefore = await evaluate(`Array.from(T.snap().filter((v, i) => i % 4 == 0)).reduce((n, v) => n + (v ? 1 : 0), 0)`)
let scaleBefore = await evaluate('view.scale')
let p1 = { x: 150, y: 400 }, p2 = { x: 240, y: 400 }
const pinchUnder = await evaluate(`board_point(${(p1.x + p2.x) / 2}, ${p1.y})`)
await touch('touchStart', [p1])
await touch('touchStart', [p1, p2])
for (let k = 1; k <= 10; k++) { await touch('touchMove', [{ x: p1.x - 4 * k, y: p1.y }, { x: p2.x + 4 * k, y: p2.y }]); await sleep(16) }
await touch('touchEnd', [])
await sleep(100)
let scaleAfter = await evaluate('view.scale')
let snapAfter = await evaluate(`Array.from(T.snap().filter((v, i) => i % 4 == 0)).reduce((n, v) => n + (v ? 1 : 0), 0)`)
check('pinch out zooms in', scaleAfter > scaleBefore * 1.5, scaleBefore + ' -> ' + scaleAfter.toFixed(1))
check('pinch draws nothing', snapAfter == snapBefore, snapBefore + ' vs ' + snapAfter)
{
    const now = await evaluate(`board_point(${(p1.x + p2.x) / 2}, ${p1.y})`)
    const err = Math.hypot(now.x - pinchUnder.x, now.y - pinchUnder.y)
    check('pinch zooms around the fingers, not the screen centre', err < 0.5, 'off by ' + err.toFixed(2) + ' cells')
}

// pinch, then lift one finger and keep moving the other: it keeps panning.
// (CDP touch events can't lift just one finger, so this sends pointer events)
{
    const r = await evaluate(`(() => {
        const ev = (type, id, x, y) => c.dispatchEvent(new PointerEvent(type, { pointerId : id, pointerType : 'touch', clientX : x, clientY : y, bubbles : true, isPrimary : id == 91 }))
        ev('pointerdown', 91, 150, 450); ev('pointerdown', 92, 250, 450)
        for (let k = 1; k <= 5; k++) { ev('pointermove', 91, 150 - 3 * k, 450); ev('pointermove', 92, 250 + 3 * k, 450) }
        ev('pointerup', 92, 265, 450)
        const under = board_point(135, 450)
        for (let k = 1; k <= 8; k++) ev('pointermove', 91, 135 + 8 * k, 450 + 6 * k)
        const now = board_point(199, 498)
        ev('pointerup', 91, 199, 498)
        return { err : Math.hypot(now.x - under.x, now.y - under.y), left : pointers.size, stroke : stroke }
    })()`)
    check('after lifting one finger of a pinch, the other keeps panning', r.err < 0.5 && r.left == 0 && r.stroke == null, 'off by ' + r.err.toFixed(2) + ' cells')
}

// screenshot of the phone layout
await evaluate(`set_zoom(12)`)
const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'phone.png'), Buffer.from(shot.data, 'base64'))

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
chrome.kill()
server.close()
process.exit(failures ? 1 : 0)
