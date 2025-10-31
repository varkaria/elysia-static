import type { BunFile } from 'bun'
import type { Stats } from 'fs'

let fs: typeof import('fs/promises')
let path: typeof import('path')

export const isBun = typeof Bun !== 'undefined' && !!Bun.file

export function getBuiltinModule() {
    if (!fs) fs = process.getBuiltinModule('fs/promises')
    if (!typeof fs) {
        console.warn('@elysiajs/static require fs/promises to be available.')
        return
    }

    if (!path) path = process.getBuiltinModule('path')
    if (!path) {
        console.warn('@elysiajs/static require path to be available.')
        return
    }

    return [fs, path] as const
}

export async function listHTMLFiles(dir: string) {
    if (!fs) getBuiltinModule()

    if (isBun) {
        const glob = new Bun.Glob('**/*.html')
        const files = []

        for await (const file of glob.scan(dir))
            files.push(path.join(dir, file))

        return files
    }

    return []
}

export async function listFiles(dir: string): Promise<string[]> {
    if (!fs) getBuiltinModule()

    if (isBun) {
        const glob = new Bun.Glob('**/*')
        const files = []

        for await (const file of glob.scan(dir))
            files.push(path.join(dir, file))

        return files
    }

    const files = await fs.readdir(dir).catch(() => [])

    const all = await Promise.all(
        files.map(async (name) => {
            const file = dir + path.sep + name
            const stats = await fs.stat(file).catch(() => null)
            if (!stats) return []

            return stats.isDirectory()
                ? await listFiles(file)
                : [path.resolve(dir, file)]
        })
    )

    return all.flat()
}

export function fileExists(path: string) {
    if (!fs) getBuiltinModule()

    return fs.stat(path).then(
        () => true,
        () => false
    )
}

export class LRUCache<K, V> {
    private map = new Map<K, [V, number]>()
    private interval: number | undefined

    constructor(
        private readonly max = 250,
        private readonly ttl = 3 * 60 * 60
    ) {}

    get(key: K): V | undefined {
        const entry = this.map.get(key)
        if (!entry) return

        if (entry[1] <= Date.now()) return void this.delete(key)

        // refresh LRU order
        this.map.delete(key)
        this.map.set(key, entry)
        return entry[0]
    }

    set(key: K, value: V): void {
        if (!this.interval)
            this.interval = setInterval(() => {
                const now = Date.now()
                for (const [key, entry] of this.map)
                    if (entry[1] <= now) this.map.delete(key)
            }, this.ttl) as unknown as number

        if (this.map.has(key)) this.map.delete(key)
        else if (this.map.size >= this.max) {
            const oldestKey = this.map.keys().next().value

            if (oldestKey !== undefined) this.delete(oldestKey)
        }

        this.map.set(key, [value, Date.now() + this.ttl * 1000])
    }

    delete(key: K): void {
        if (!this.map.get(key)) return

        this.map.delete(key)
    }

    clear(): void {
        this.map.clear()
    }

    size(): number {
        return this.map.size
    }

    [Symbol.dispose]() {
        if (this.interval) clearInterval(this.interval)
    }
}

export function isCached(
    headers: Record<string, string | undefined>,
    etag: string,
    filePath: string
) {
    // Always return stale when Cache-Control: no-cache
    // to support end-to-end reload requests
    // https://tools.ietf.org/html/rfc2616#section-14.9.4
    if (
        headers['cache-control'] &&
        /no-cache|no-store/.test(headers['cache-control'])
    )
        return false

    if ('if-none-match' in headers) {
        const ifNoneMatch = headers['if-none-match']

        if (ifNoneMatch === '*') return true
        if (ifNoneMatch === null) return false
        if (typeof etag !== 'string') return false

        const isMatching = ifNoneMatch === etag

        if (isMatching) return true

        /**
         * A recipient MUST ignore If-Modified-Since if the request contains an
         * If-None-Match header field; the condition in If-None-Match is considered
         * to be a more accurate replacement for the condition in If-Modified-Since,
         * and the two are only combined for the sake of interoperating with older
         * intermediaries that might not implement If-None-Match.
         *
         * @see RFC 9110 section 13.1.3
         */
        return false
    }

    if (headers['if-modified-since']) {
        const ifModifiedSince = headers['if-modified-since']

        try {
            return fs.stat(filePath).then((stat) => {
                if (
                    stat.mtime !== undefined &&
                    stat.mtime.getTime() <= Date.parse(ifModifiedSince)
                )
                    return true
            })
        } catch {}
    }

    return false
}

let Crypto: typeof import('crypto')

export function getFile(path: string) {
    if (isBun) return Bun.file(path)

    if (!fs) getBuiltinModule()
    return fs.readFile(path)
}

export async function generateETag(file: BunFile | Buffer<ArrayBufferLike>) {
    if (isBun)
        return new Bun.CryptoHasher('md5')
            .update(await (file as BunFile).arrayBuffer())
            .digest('base64')

    if (!crypto) Crypto = process.getBuiltinModule('crypto')
    if (!crypto)
        return void console.warn(
            '[@elysiajs/static] crypto is required to generate etag.'
        )

    return Crypto.createHash('md5')
        .update(file as Buffer)
        .digest('base64')
}

export const isNotEmpty = (obj?: Object) => {
    if (!obj) return false

    for (const _ in obj) return true

    return false
}

export interface Range {
    start: number
    end: number
}

/**
 * Parse Range header value
 * Supports: bytes=start-end format
 * Returns null if invalid or not a bytes range
 */
export function parseRange(
    rangeHeader: string | undefined | null,
    fileSize: number
): Range | null {
    if (!rangeHeader || !rangeHeader.startsWith('bytes=')) {
        return null
    }

    const ranges = rangeHeader.slice(6).split(',')
    // For simplicity, we only handle the first range
    const range = ranges[0]?.trim()
    if (!range) return null

    const parts = range.split('-')
    if (parts.length !== 2) return null

    const startStr = parts[0]
    const endStr = parts[1]

    let start: number
    let end: number

    if (startStr === '') {
        // Suffix range: -500 means last 500 bytes
        const suffix = parseInt(endStr, 10)
        if (isNaN(suffix) || suffix <= 0) return null
        start = Math.max(0, fileSize - suffix)
        end = fileSize - 1
    } else if (endStr === '') {
        // Prefix range: 500- means from byte 500 to end
        start = parseInt(startStr, 10)
        if (isNaN(start) || start < 0) return null
        end = fileSize - 1
    } else {
        // Full range: 500-999
        start = parseInt(startStr, 10)
        end = parseInt(endStr, 10)
        if (isNaN(start) || isNaN(end) || start < 0 || end < start) return null
    }

    // Clamp to file size
    start = Math.max(0, Math.min(start, fileSize - 1))
    end = Math.max(start, Math.min(end, fileSize - 1))

    return { start, end }
}

/**
 * Read a range of bytes from a file
 */
export async function getFileRange(
    path: string,
    range: Range
): Promise<Buffer | null> {
    if (isBun) {
        const file = Bun.file(path)
        const fileSize = file.size
        if (range.start >= fileSize || range.end >= fileSize) return null

        const arrayBuffer = await file.arrayBuffer()
        return Buffer.from(arrayBuffer.slice(range.start, range.end + 1))
    }

    if (!fs) getBuiltinModule()

    // For Node.js, we need to open the file and read a specific range
    const fd = await fs.open(path, 'r').catch(() => null)
    if (!fd) return null

    try {
        const length = range.end - range.start + 1
        const buffer = Buffer.allocUnsafe(length)
        const result = await fd.read(buffer, 0, length, range.start)
        if (result.bytesRead === 0) return null
        return buffer.subarray(0, result.bytesRead)
    } finally {
        await fd.close()
    }
}

/**
 * Format Content-Range header value
 */
export function formatContentRange(range: Range, fileSize: number): string {
    return `bytes ${range.start}-${range.end}/${fileSize}`
}
