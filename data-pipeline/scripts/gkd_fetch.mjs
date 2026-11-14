// Bulk GKD Bayern download: reproduces the verified "Direkter Download" flow
// (Gesamtzeitraum + Tageswerte -> enqueue_download -> poll deeplink -> &dl=1)
// for every station in data/raw/gkd/README.md, one at a time, >=10s apart,
// normal browser UA, no retries/proxies/faked cookies. Stops immediately on
// any WAF/block signal and reports which stations are left.
//
// Run successfully end-to-end 2026-11-13: 17 W files + 2 real Q files (see
// README.md), zero blocks. Two URL corrections baked in below after
// checking the actual downloaded headers against what they claimed to be:
// München and Landshut Birket's original "Stammdaten URL" pointed at the
// Abfluss category page, which silently returns discharge data under a
// Wasserstand-shaped download flow -- the real Wasserstand URL is the
// "wasserstand" category instead, at the same site number.
import { chromium } from 'playwright'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'

const OUT_DIR = '/Users/iran/Desktop/theses/bavaria/wassserklima-bayern/data/raw/gkd'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

// [stammdatenUrl, outFilename]
const STATIONS_W = [
  ['https://www.gkd.bayern.de/de/fluesse/wasserstand/bayern/neu-ulm-10026293', 'neu-ulm-10026293_W.csv'],
  // Despite the "-q-" in its slug, this is a separate W-only gauge, not a Q
  // companion to Neu-Ulm -- verified against the real file's own header.
  ['https://www.gkd.bayern.de/de/fluesse/wasserstand/kelheim/neu-ulm-bad-held-q-10026301', 'neu-ulm-bad-held-10026301_W.csv'],
  ['https://www.gkd.bayern.de/de/fluesse/wasserstand/kelheim/ingolstadt-luitpoldstrasse-10046105', 'ingolstadt-luitpoldstrasse-10046105_W.csv'],
  ['https://www.gkd.bayern.de/de/fluesse/wasserstand/passau/schwabelweis-10062000', 'schwabelweis-10062000_W.csv'],
  ['https://www.gkd.bayern.de/de/fluesse/wasserstand/passau/deggendorf-10081004', 'deggendorf-10081004_W.csv'],
  ['https://www.gkd.bayern.de/de/fluesse/wasserstand/bayern/passau-10091008', 'passau-10091008_W.csv'],
  ['https://www.gkd.bayern.de/de/fluesse/wasserstand/bayern/donauwoerth-10039802', 'donauwoerth-10039802_W.csv'],
  ['https://www.gkd.bayern.de/de/fluesse/wasserstand/bayern/rosenheim-o-d-mangfallmuendung-18001508', 'rosenheim-od-mangfallmuendung-18001508_W.csv'],
  ['https://www.gkd.bayern.de/de/fluesse/wasserstand/isar/muehldorf-18004506', 'muehldorf-18004506_W.csv'],
  ['https://www.gkd.bayern.de/de/fluesse/wasserstand/passau/passau-ingling-18008008', 'passau-ingling-18008008_W.csv'],
  ['https://www.gkd.bayern.de/de/fluesse/wasserstand/isar/muenchen-16005701', 'muenchen-16005701_W.csv'],
  ['https://www.gkd.bayern.de/de/fluesse/abfluss/bayern/muenchen-16005701', 'muenchen-16005701_Q.csv'],
  ['https://www.gkd.bayern.de/de/fluesse/wasserstand/isar/landshut-birket-16007004', 'landshut-birket-16007004_W.csv'],
  ['https://www.gkd.bayern.de/de/fluesse/abfluss/isar/landshut-birket-16007004', 'landshut-birket-16007004_Q.csv'],
  ['https://www.gkd.bayern.de/de/fluesse/wasserstand/bayern/augsburg-u-d-wertachmuendung-12006000', 'augsburg-uwertachmuendung-12006000_W.csv'],
  ['https://www.gkd.bayern.de/de/seen/wasserstand/isar/stock-18400503', 'stock-18400503_W.csv'],
  ['https://www.gkd.bayern.de/de/seen/wasserstand/isar/starnberg-16663002', 'starnberg-16663002_W.csv'],
  ['https://www.gkd.bayern.de/de/seen/wasserstand/isar/stegen-16602008', 'stegen-16602008_W.csv'],
]

function log(...args) { console.log(new Date().toISOString(), ...args) }

async function fetchOne(page, pageUrl, outName) {
  const url = pageUrl.replace(/\/?$/, '/download')
  let deeplink = null
  const listener = async res => {
    if (res.url().includes('enqueue_download')) {
      const json = await res.json().catch(() => null)
      if (json) deeplink = json.deeplink
    }
  }
  page.on('response', listener)
  try {
    const nav = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
    if (!nav || nav.status() >= 400) return { status: 'ERROR', detail: `page status ${nav && nav.status()}` }
    const title = await page.title()
    if (/request rejected|forbidden|captcha/i.test(title)) return { status: 'BLOCKED', detail: title }

    await page.waitForTimeout(800)
    const select = await page.$('select')
    if (select) {
      await select.selectOption('gesamt').catch(() => {})
      await select.evaluate(el => el.dispatchEvent(new Event('change', { bubbles: true })))
      await page.waitForTimeout(500)
    }
    const dlButton = await page.$('#dlbutton')
    if (!dlButton) return { status: 'ERROR', detail: 'no #dlbutton on page -- structure differs' }
    await dlButton.click()
    await page.waitForTimeout(800)
    const directRadio = await page.$('#diadown-download')
    if (!directRadio) return { status: 'ERROR', detail: 'no #diadown-download radio' }
    await directRadio.check()
    const tac = await page.$('#tac'); if (tac) await tac.check()
    const priv = await page.$('#privacy'); if (priv) await priv.check()
    await page.waitForTimeout(300)
    const okBtn = await page.$('#download-ok-button')
    if (!okBtn) return { status: 'ERROR', detail: 'no #download-ok-button' }
    await okBtn.click()
    await page.waitForTimeout(1500)

    if (!deeplink) return { status: 'ERROR', detail: 'no deeplink from enqueue_download' }

    await page.goto(deeplink, { waitUntil: 'networkidle' })
    let ready = false
    for (let i = 0; i < 18; i++) {
      const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '')
      if (/steht zur Verf/i.test(bodyText)) { ready = true; break }
      if (/request rejected|blocked|captcha|gesperrt/i.test(bodyText)) return { status: 'BLOCKED', detail: 'blocked while polling deeplink' }
      await page.waitForTimeout(10000)
    }
    if (!ready) return { status: 'TIMEOUT', detail: 'file never became ready in 3 min' }

    const fileUrl = deeplink + '&dl=1'
    const downloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null)
    await page.goto(fileUrl).catch(() => {})
    const download = await downloadPromise
    if (!download) return { status: 'ERROR', detail: 'no download event from &dl=1' }

    const tmpPath = path.join(os.tmpdir(), outName + '.download')
    await download.saveAs(tmpPath)
    return { status: 'OK', tmpPath }
  } finally {
    page.off('response', listener)
  }
}

function assembleCsv(tmpPath, outPath) {
  // The download may be a plain CSV or a ZIP of several date-range-split
  // CSVs (seen for Passau: beginn..2025, then year-to-date chunks). Detect
  // by magic bytes, not by trusting any extension.
  const buf = fs.readFileSync(tmpPath)
  const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b
  if (!isZip) {
    fs.copyFileSync(tmpPath, outPath)
    return { zipped: false, parts: 1 }
  }
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gkdzip-'))
  execSync(`unzip -o -q ${JSON.stringify(tmpPath)} -d ${JSON.stringify(extractDir)}`)
  const rawFiles = execSync(`find ${JSON.stringify(extractDir)} -name "*.csv"`).toString().trim().split('\n').filter(Boolean)
  if (rawFiles.length === 0) throw new Error('zip contained no CSV files')

  // GKD splits a long request into several date-range chunks, but the chunk
  // FILENAMES don't sort chronologically (e.g. "...01.01.2026_31.10.2026..."
  // sorts before "...beginn_bis_31.12.2025..." alphabetically, since '0' <
  // 'b') -- verified directly against a real multi-chunk Passau download
  // before trusting filename order. Sort by each chunk's own first real
  // data date instead.
  function firstDataLine(f) {
    const lines = fs.readFileSync(f, 'utf-8').split(/\r\n|\n/)
    const idx = lines.findIndex(l => l.startsWith('Datum;'))
    if (idx === -1) throw new Error(`could not find "Datum;" column header in ${f}`)
    const dataLines = lines.slice(idx + 1).filter(l => l.trim().length > 0)
    return { idx, lines, dataLines, firstDate: dataLines[0] ? dataLines[0].split(';')[0] : null }
  }
  const parsed = rawFiles.map(f => ({ f, ...firstDataLine(f) }))
  parsed.sort((a, b) => (a.firstDate || '').localeCompare(b.firstDate || ''))

  const headerBlock = parsed[0].lines.slice(0, parsed[0].idx + 1)
  let allDataLines = []
  for (const p of parsed) allDataLines = allDataLines.concat(p.dataLines)
  fs.writeFileSync(outPath, headerBlock.join('\r\n') + '\r\n' + allDataLines.join('\r\n') + '\r\n', 'utf-8')
  return { zipped: true, parts: parsed.length, order: parsed.map(p => path.basename(p.f)) }
}

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage({ userAgent: UA, acceptDownloads: true })

  const results = []
  for (const [pageUrl, outName] of STATIONS_W) {
    const outPath = path.join(OUT_DIR, outName)
    if (fs.existsSync(outPath)) {
      log('SKIP (already present):', outName)
      results.push({ outName, status: 'SKIP-EXISTS' })
      continue
    }
    log('Fetching', outName, 'from', pageUrl)
    const r = await fetchOne(page, pageUrl, outName)
    if (r.status === 'OK') {
      try {
        const info = assembleCsv(r.tmpPath, outPath)
        // Verify the file actually contains what its _W/_Q suffix claims --
        // caught two real mislabeled URLs this way (München, Landshut
        // Birket both silently returned Abfluss under a Wasserstand flow).
        const headSample = fs.readFileSync(outPath, 'utf-8').slice(0, 2000)
        const expectWasserstand = outName.endsWith('_W.csv')
        const sawWasserstand = /Tageswerte Wasserstand/i.test(headSample)
        const sawAbfluss = /Tageswerte Abfluss/i.test(headSample)
        if (expectWasserstand && !sawWasserstand && sawAbfluss) {
          log('  MISMATCH: filename says _W but file contains Abfluss data -- not saving under this name, inspect the URL.')
          results.push({ outName, status: 'LABEL_MISMATCH', detail: 'file contains Abfluss, not Wasserstand' })
          continue
        }
        if (!expectWasserstand && !sawAbfluss && sawWasserstand) {
          log('  MISMATCH: filename says _Q but file contains Wasserstand data -- not saving under this name, inspect the URL.')
          results.push({ outName, status: 'LABEL_MISMATCH', detail: 'file contains Wasserstand, not Abfluss' })
          continue
        }
        log('  OK ->', outName, JSON.stringify(info))
        results.push({ outName, status: 'OK', ...info })
      } catch (e) {
        log('  ASSEMBLE FAILED:', e.message)
        results.push({ outName, status: 'ASSEMBLE_FAILED', detail: e.message })
      }
    } else {
      log(' ', r.status, r.detail)
      results.push({ outName, status: r.status, detail: r.detail })
    }

    if (r.status === 'BLOCKED') {
      log('BLOCKED -- stopping immediately, not trying further stations.')
      break
    }

    log('Waiting 12s before next station...')
    await page.waitForTimeout(12000)
  }

  await browser.close()
  console.log('\n=== SUMMARY ===')
  for (const res of results) console.log(JSON.stringify(res))
  fs.writeFileSync('/tmp/gkd_bulk_fetch_results.json', JSON.stringify(results, null, 2))
}

main()
