import sharp from "sharp"
import fs from "fs"
import path from "path"

const LOGOS_DIR = path.resolve(
  "src/uploads/games"
)

// Logos are displayed at 60×60 px — 128×128 is crisp at 2× retina
const TARGET_SIZE = 128

async function main() {
  const files = fs
    .readdirSync(LOGOS_DIR)
    .filter((f) =>
      /\.(png|jpg|jpeg|webp)$/i.test(f)
    )

  console.log(
    `Compressing ${files.length} logo(s) in ${LOGOS_DIR}…\n`
  )

  let totalBefore = 0
  let totalAfter = 0

  for (const file of files) {
    const filePath = path.join(
      LOGOS_DIR,
      file
    )

    const before = fs.statSync(filePath).size

    // Resize + compress in memory, then overwrite
    const compressed = await sharp(filePath)
      .resize(TARGET_SIZE, TARGET_SIZE, {
        fit: "contain",          // preserve aspect ratio, pad with transparency
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png({
        compressionLevel: 9,     // max zlib compression (lossless)
        adaptiveFiltering: true, // better compression on varied images
        palette: false,          // keep full colour depth for logos
      })
      .toBuffer()

    fs.writeFileSync(filePath, compressed)

    const after = compressed.byteLength

    totalBefore += before
    totalAfter += after

    const saved = (
      ((before - after) / before) *
      100
    ).toFixed(1)

    console.log(
      `  ${file.padEnd(30)} ${kb(before).padStart(8)} → ${kb(after).padStart(8)}  (−${saved}%)`
    )
  }

  console.log(
    `\nTotal: ${kb(totalBefore)} → ${kb(totalAfter)}  (saved ${kb(totalBefore - totalAfter)})`
  )
}

function kb(bytes: number) {
  return `${(bytes / 1024).toFixed(1)} KB`
}

main().catch(console.error)
