// The audio content hash is what makes the database the source of truth: a file that moves, gets
// renamed, or gets retagged must remain recognisably the same file (DESIGN-SPEC §3.7).

import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hashAudio } from '@main/library/audio-hash'

let dir: string

/** A minimal but structurally valid FLAC: 'fLaC' + STREAMINFO block with a known MD5. */
function flacWith(md5: Buffer, audio: Buffer): Buffer {
  const streaminfo = Buffer.alloc(34)
  streaminfo.writeUInt16BE(4096, 0)   // min block size
  streaminfo.writeUInt16BE(4096, 2)   // max block size
  md5.copy(streaminfo, 18)
  const header = Buffer.from([0x00, 0x00, 0x00, 0x22]) // type 0, length 34
  const last = Buffer.from([0x81, 0x00, 0x00, 0x04])   // last block, padding
  return Buffer.concat([Buffer.from('fLaC'), header, streaminfo, last, Buffer.alloc(4), audio])
}

/** ID3v2.4 header with a syncsafe size, followed by frames and an optional ID3v1 trailer. */
function mp3With(tagBytes: number, audio: Buffer, id3v1 = false): Buffer {
  const header = Buffer.alloc(10)
  header.write('ID3', 0, 'latin1')
  header[3] = 4
  const size = tagBytes
  header[6] = (size >> 21) & 0x7f
  header[7] = (size >> 14) & 0x7f
  header[8] = (size >> 7) & 0x7f
  header[9] = size & 0x7f

  const parts = [header, Buffer.alloc(tagBytes, 0x61), audio]
  if (id3v1) {
    const v1 = Buffer.alloc(128)
    v1.write('TAG', 0, 'latin1')
    parts.push(v1)
  }
  return Buffer.concat(parts)
}

function box(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(8 + payload.length, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, payload])
}

/** ftyp, then moov carrying a tag of the given size, then mdat; or mdat first when `mdatFirst`. */
function m4aWith(tagBytes: number, audio: Buffer, mdatFirst = false): Buffer {
  const ftyp = box('ftyp', Buffer.from('M4A \0\0\0\0M4A isom', 'latin1'))
  const moov = box('moov', box('udta', box('meta', Buffer.alloc(tagBytes, 0x61))))
  const mdat = box('mdat', audio)
  return Buffer.concat(mdatFirst ? [ftyp, mdat, moov] : [ftyp, moov, mdat])
}

/** One Ogg page holding the given lacing values and body; CRC is left zero, which the hasher never checks. */
function oggPage(serial: number, seq: number, flags: number, lacing: number[], body: Buffer): Buffer {
  const head = Buffer.alloc(27)
  head.write('OggS', 0, 'latin1')
  head[5] = flags
  head.writeUInt32LE(serial, 14)
  head.writeUInt32LE(seq, 18)
  head[26] = lacing.length
  return Buffer.concat([head, Buffer.from(lacing), body])
}

/** Lacing values for one whole packet of length `n`. */
const lace = (n: number): number[] => [...Array<number>(Math.floor(n / 255)).fill(255), n % 255]

/**
 * An Opus stream: OpusHead on its own page, OpusTags of the given size on the next (spilling over
 * pages when large, as real retags do), then audio packets paginated after it.
 */
function opusWith(tagBytes: number, audioPackets: Buffer[], serial = 1): Buffer {
  const pages: Buffer[] = []
  let seq = 0
  const opusHead = Buffer.concat([Buffer.from('OpusHead', 'latin1'), Buffer.alloc(11, 1)])
  pages.push(oggPage(serial, seq++, 0x02, lace(opusHead.length), opusHead))

  // Split the comment packet across pages of at most 4 full segments each.
  const tags = Buffer.concat([Buffer.from('OpusTags', 'latin1'), Buffer.alloc(tagBytes, 0x61)])
  const tagLacing = lace(tags.length)
  let at = 0
  for (let i = 0; i < tagLacing.length; i += 4) {
    const l = tagLacing.slice(i, i + 4)
    const n = l.reduce((a, b) => a + b, 0)
    pages.push(oggPage(serial, seq++, i === 0 ? 0 : 0x01, l, tags.subarray(at, at + n)))
    at += n
  }

  audioPackets.forEach((p, i) =>
    pages.push(oggPage(serial, seq++, i === audioPackets.length - 1 ? 0x04 : 0, lace(p.length), p)))
  return Buffer.concat(pages)
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'anthem-hash-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('audio content hash', () => {
  it('uses the FLAC STREAMINFO MD5, which is already in the file', async () => {
    const md5 = Buffer.from('0123456789abcdef0123456789abcdef', 'hex')
    const p = join(dir, 'a.flac')
    await writeFile(p, flacWith(md5, Buffer.alloc(2048, 7)))

    const h = await hashAudio(p)
    expect(h.algo).toBe('flac-streaminfo-md5')
    expect(h.hash.toString('hex')).toBe(md5.toString('hex'))
  })

  it('ignores an all-zero STREAMINFO MD5, which means the encoder computed none', async () => {
    const p = join(dir, 'zero.flac')
    await writeFile(p, flacWith(Buffer.alloc(16), Buffer.alloc(2048, 7)))

    const h = await hashAudio(p)
    expect(h.algo).not.toBe('flac-streaminfo-md5')
  })

  it('is unchanged when an ID3v2 tag grows, since only frames are hashed', async () => {
    const audio = Buffer.alloc(4096, 0x5a)
    const small = join(dir, 'small.mp3')
    const large = join(dir, 'large.mp3')
    await writeFile(small, mp3With(64, audio))
    await writeFile(large, mp3With(8192, audio))

    const a = await hashAudio(small)
    const b = await hashAudio(large)
    expect(a.algo).toBe('sha256-frames')
    expect(b.hash.toString('hex')).toBe(a.hash.toString('hex'))
  })

  it('is unchanged when an ID3v1 trailer is added', async () => {
    const audio = Buffer.alloc(4096, 0x33)
    const without = join(dir, 'no-v1.mp3')
    const with_ = join(dir, 'with-v1.mp3')
    await writeFile(without, mp3With(64, audio))
    await writeFile(with_, mp3With(64, audio, true))

    const a = await hashAudio(without)
    const b = await hashAudio(with_)
    expect(b.hash.toString('hex')).toBe(a.hash.toString('hex'))
  })

  it('is unchanged by a rename, which is what move detection depends on', async () => {
    const audio = Buffer.alloc(1024, 0x11)
    const before = join(dir, 'before.mp3')
    const after = join(dir, 'deep-renamed.mp3')
    await writeFile(before, mp3With(32, audio))

    const a = await hashAudio(before)
    await rename(before, after)
    const b = await hashAudio(after)

    expect(b.hash.toString('hex')).toBe(a.hash.toString('hex'))
  })

  it('distinguishes different audio content', async () => {
    const x = join(dir, 'x.mp3')
    const y = join(dir, 'y.mp3')
    await writeFile(x, mp3With(32, Buffer.alloc(2048, 1)))
    await writeFile(y, mp3With(32, Buffer.alloc(2048, 2)))

    const a = await hashAudio(x)
    const b = await hashAudio(y)
    expect(b.hash.toString('hex')).not.toBe(a.hash.toString('hex'))
  })

  it('hashes only MP4 mdat, so a grown tag or a moved moov leaves it unchanged', async () => {
    const audio = Buffer.alloc(4096, 0x42)
    const a = join(dir, 'a.m4a')
    const b = join(dir, 'b.m4a')
    const c = join(dir, 'c.m4a')
    await writeFile(a, m4aWith(64, audio))
    await writeFile(b, m4aWith(9000, audio))
    await writeFile(c, m4aWith(64, audio, true))

    const ha = await hashAudio(a)
    expect(ha.algo).toBe('sha256-mdat')
    expect((await hashAudio(b)).hash.toString('hex')).toBe(ha.hash.toString('hex'))
    expect((await hashAudio(c)).hash.toString('hex')).toBe(ha.hash.toString('hex'))
  })

  it('distinguishes MP4 files with different audio', async () => {
    const x = join(dir, 'x.m4a')
    const y = join(dir, 'y.m4a')
    await writeFile(x, m4aWith(64, Buffer.alloc(2048, 1)))
    await writeFile(y, m4aWith(64, Buffer.alloc(2048, 2)))

    expect((await hashAudio(y)).hash.toString('hex')).not.toBe((await hashAudio(x)).hash.toString('hex'))
  })

  it('falls back to a whole-file hash for a truncated MP4', async () => {
    const p = join(dir, 'truncated.m4a')
    await writeFile(p, m4aWith(64, Buffer.alloc(2048, 3)).subarray(0, 100))

    expect((await hashAudio(p)).algo).toBe('sha256-file')
  })

  it('hashes Ogg packets without the comment, so a retag that repaginates leaves it unchanged', async () => {
    const audio = [Buffer.alloc(300, 5), Buffer.alloc(40, 6), Buffer.alloc(700, 7)]
    const small = join(dir, 'small.opus')
    const large = join(dir, 'large.opus')
    await writeFile(small, opusWith(20, audio))
    await writeFile(large, opusWith(5000, audio, 99))

    const a = await hashAudio(small)
    expect(a.algo).toBe('sha256-ogg-packets')
    expect((await hashAudio(large)).hash.toString('hex')).toBe(a.hash.toString('hex'))
  })

  it('distinguishes Ogg files with different audio', async () => {
    const x = join(dir, 'x.opus')
    const y = join(dir, 'y.opus')
    await writeFile(x, opusWith(20, [Buffer.alloc(300, 1)]))
    await writeFile(y, opusWith(20, [Buffer.alloc(300, 2)]))

    expect((await hashAudio(y)).hash.toString('hex')).not.toBe((await hashAudio(x)).hash.toString('hex'))
  })

  it('falls back to a whole-file hash for an Ogg codec whose comment packet it does not know', async () => {
    const p = join(dir, 'theora.ogg')
    const head = Buffer.from('\x80theora-and-more', 'latin1')
    await writeFile(p, oggPage(1, 0, 0x02, lace(head.length), head))

    expect((await hashAudio(p)).algo).toBe('sha256-file')
  })
})
