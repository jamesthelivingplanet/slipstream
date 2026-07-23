import { describe, it, expect, vi } from 'vitest'
import {
  bytesToBase64,
  blobToBase64,
  uploadClipboardImage,
  type ImageUploadDeps,
} from './imageUpload.js'

describe('bytesToBase64', () => {
  it('encodes known small byte arrays', () => {
    expect(bytesToBase64(new Uint8Array([]))).toBe('')
    expect(bytesToBase64(new Uint8Array([102, 111, 111]))).toBe('Zm9v') // "foo"
    expect(bytesToBase64(new Uint8Array([0]))).toBe(Buffer.from([0]).toString('base64'))
    expect(bytesToBase64(new Uint8Array([255, 254, 253]))).toBe(
      Buffer.from([255, 254, 253]).toString('base64'),
    )
  })

  it('chunks large arrays without stack overflow and matches Buffer output', () => {
    const size = 200_000 // > 64 KiB, spans multiple 0x8000 chunks
    const bytes = new Uint8Array(size)
    for (let i = 0; i < size; i++) bytes[i] = i % 256
    const result = bytesToBase64(bytes)
    expect(result).toBe(Buffer.from(bytes).toString('base64'))
  })
})

describe('blobToBase64', () => {
  it('matches bytesToBase64 for a small blob', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const blob = new Blob([bytes])
    const result = await blobToBase64(blob)
    expect(result).toBe(bytesToBase64(bytes))
  })

  it('handles an empty blob', async () => {
    const blob = new Blob([])
    const result = await blobToBase64(blob)
    expect(result).toBe('')
  })

  it('matches Buffer.from(...).toString("base64") for a larger blob', async () => {
    const size = 100_000
    const bytes = new Uint8Array(size)
    for (let i = 0; i < size; i++) bytes[i] = (i * 7) % 256
    const blob = new Blob([bytes])
    const result = await blobToBase64(blob)
    expect(result).toBe(Buffer.from(bytes).toString('base64'))
  })
})

describe('uploadClipboardImage', () => {
  function makeDeps(calls: string[]): ImageUploadDeps & {
    syncClipboardImage: ReturnType<typeof vi.fn>
    writeSession: ReturnType<typeof vi.fn>
    markSessionInput: ReturnType<typeof vi.fn>
  } {
    return {
      syncClipboardImage: vi.fn(async (id: string, dataBase64: string) => {
        calls.push(`sync:${id}:${dataBase64}`)
      }),
      markSessionInput: vi.fn((id: string) => {
        calls.push(`mark:${id}`)
      }),
      writeSession: vi.fn((id: string, data: string) => {
        calls.push(`write:${id}:${data}`)
      }),
    }
  }

  it('calls syncClipboardImage with the correct base64, resolving before markSessionInput/writeSession', async () => {
    const calls: string[] = []
    const deps = makeDeps(calls)
    const bytes = new Uint8Array([104, 105]) // "hi"
    const blob = new Blob([bytes])
    await uploadClipboardImage(deps, 'sess1', blob)

    const expectedB64 = bytesToBase64(bytes)
    expect(deps.syncClipboardImage).toHaveBeenCalledWith('sess1', expectedB64)
    expect(calls).toEqual([`sync:sess1:${expectedB64}`, 'mark:sess1', 'write:sess1:\x16'])
  })

  it('writeSession is only ever called with the literal Ctrl+V byte', async () => {
    const calls: string[] = []
    const deps = makeDeps(calls)
    await uploadClipboardImage(deps, 'sess1', new Blob([new Uint8Array([1])]))
    expect(deps.writeSession).toHaveBeenCalledTimes(1)
    expect(deps.writeSession).toHaveBeenCalledWith('sess1', '\x16')
  })

  it('propagates a syncClipboardImage rejection and never calls writeSession', async () => {
    const calls: string[] = []
    const deps = makeDeps(calls)
    const err = new Error('upload failed')
    deps.syncClipboardImage.mockRejectedValueOnce(err)

    await expect(
      uploadClipboardImage(deps, 'sess1', new Blob([new Uint8Array([1])])),
    ).rejects.toThrow('upload failed')
    expect(deps.writeSession).not.toHaveBeenCalled()
    expect(deps.markSessionInput).not.toHaveBeenCalled()
  })
})
