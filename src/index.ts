import { Elysia, NotFoundError } from 'elysia'

import type { Stats } from 'fs'

import fastDecodeURI from 'fast-decode-uri-component'

import {
    LRUCache,
    fileExists,
    getBuiltinModule,
    listFiles,
    generateETag,
    isCached,
    getFile,
    isBun,
    listHTMLFiles,
    isNotEmpty,
    parseRange,
    getFileRange,
    formatContentRange
} from './utils'
import type { StaticOptions } from './types'



export async function staticPlugin<const Prefix extends string = '/prefix'>({
    assets = 'public',
    prefix = '/public' as Prefix,
    staticLimit = 1024,
    alwaysStatic = process.env.NODE_ENV === 'production',
    ignorePatterns = ['.DS_Store', '.git', '.env'],
    headers: initialHeaders,
    maxAge = 86400,
    directive = 'public',
    etag: useETag = true,
    extension = true,
    indexHTML = true,
    decodeURI,
    silent
}: StaticOptions<Prefix> = {}): Promise<Elysia> {
    if (
        typeof process === 'undefined' ||
        typeof process.getBuiltinModule === 'undefined'
    ) {
        if (!silent)
            console.warn(
                '[@elysiajs/static] require process.getBuiltinModule. Static plugin is disabled'
            )

        return new Elysia()
    }

    const builtinModule = getBuiltinModule()
    if (!builtinModule) return new Elysia()

    const [fs, path] = builtinModule

    const fileCache = new LRUCache<string, Response>()

    if (prefix === path.sep) prefix = '' as Prefix
    const assetsDir = path.resolve(assets)
    const shouldIgnore = !ignorePatterns.length
        ? () => false
        : (file: string) =>
            ignorePatterns.find((pattern) =>
                typeof pattern === 'string'
                    ? pattern.includes(file)
                    : pattern.test(file)
            )

    const app = new Elysia({
        name: 'static',
        seed: prefix
    })

    if (alwaysStatic) {
        const files = await listFiles(path.resolve(assets))

        if (files.length <= staticLimit)
            for (const absolutePath of files) {
                if (!absolutePath || shouldIgnore(absolutePath)) continue

                let relativePath = absolutePath.replace(assetsDir, '')
                if (decodeURI)
                    relativePath = fastDecodeURI(relativePath) ?? relativePath

                let pathName = path.join(prefix, relativePath)

                if (isBun && absolutePath.endsWith('.html')) {
                    const htmlBundle = await import(absolutePath)

                    app.get(pathName, htmlBundle.default)
                    if (indexHTML && pathName.endsWith('/index.html'))
                        app.get(
                            pathName.replace('/index.html', ''),
                            htmlBundle.default
                        )

                    continue
                }

                if (!extension)
                    pathName = pathName.slice(0, pathName.lastIndexOf('.'))

                const file: Awaited<ReturnType<typeof getFile>> = isBun
                    ? getFile(absolutePath)
                    : ((await getFile(absolutePath)) as any)

                if (!file) {
                    if (!silent)
                        console.warn(
                            `[@elysiajs/static] Failed to load file: ${absolutePath}`
                        )

                    return new Elysia()
                }

                const etag = await generateETag(file)

                // Get file size for range requests
                const fileSize = isBun
                    ? (file as any).size
                    : (file as Buffer).length

                async function handleRangeRequest(
                    requestHeaders: Record<string, string>,
                    fileData: typeof file,
                    fileSize: number
                ): Promise<Response | null> {
                    const rangeHeader = requestHeaders['range']
                    if (!rangeHeader) return null

                    const range = parseRange(rangeHeader, fileSize)
                    if (!range) return null

                    let rangeData: Buffer | ArrayBuffer
                    if (isBun) {
                        const arrayBuffer = await (fileData as any).arrayBuffer()
                        rangeData = arrayBuffer.slice(range.start, range.end + 1)
                    } else {
                        const buffer = fileData as Buffer
                        rangeData = buffer.subarray(range.start, range.end + 1)
                    }

                    const headers = Object.assign(
                        {
                            'Content-Range': formatContentRange(range, fileSize),
                            'Cache-Control': maxAge
                                ? `${directive}, max-age=${maxAge}`
                                : directive,
                            'Accept-Ranges': 'bytes'
                        },
                        initialHeaders,
                        etag ? { Etag: etag } : {}
                    )

                    return new Response(rangeData, {
                        status: 206,
                        headers
                    })
                }

                async function handleCache({
                    headers: requestHeaders
                }: {
                    headers: Record<string, string>
                }) {
                    // Check for range request first
                    const rangeResponse = await handleRangeRequest(
                        requestHeaders,
                        file,
                        fileSize
                    )
                    if (rangeResponse) return rangeResponse

                    if (etag) {
                        let cached = isCached(
                            requestHeaders as any,
                            etag,
                            absolutePath
                        )

                        if (cached === true)
                            return new Response(null, {
                                status: 304,
                                headers: isNotEmpty(initialHeaders)
                                    ? initialHeaders
                                    : undefined
                            })
                        else if (cached !== false) {
                            const cache = fileCache.get(pathName)
                            if (cache) return cache.clone()

                            return cached.then(async (cached) => {
                                if (cached)
                                    return new Response(null, {
                                        status: 304,
                                        headers: initialHeaders
                                            ? initialHeaders
                                            : undefined
                                    })

                                const response = new Response(file, {
                                    headers: Object.assign(
                                        {
                                            'Cache-Control': maxAge
                                                ? `${directive}, max-age=${maxAge}`
                                                : directive,
                                            'Accept-Ranges': 'bytes'
                                        },
                                        initialHeaders,
                                        etag ? { Etag: etag } : {}
                                    )
                                })
                                fileCache.set(pathName, response)

                                return response.clone()
                            })
                        }
                    }

                    const cache = fileCache.get(pathName)
                    if (cache) return cache.clone()

                    const response = new Response(file, {
                        headers: Object.assign(
                            {
                                'Cache-Control': maxAge
                                    ? `${directive}, max-age=${maxAge}`
                                    : directive,
                                'Accept-Ranges': 'bytes'
                            },
                            initialHeaders,
                            etag ? { Etag: etag } : {}
                        )
                    })

                    fileCache.set(pathName, response)

                    return response.clone()
                }

                async function handleWithoutETag({
                    headers: requestHeaders
                }: {
                    headers: Record<string, string>
                }) {
                    // Check for range request first
                    const rangeResponse = await handleRangeRequest(
                        requestHeaders,
                        file,
                        fileSize
                    )
                    if (rangeResponse) return rangeResponse

                    return new Response(
                        file,
                        isNotEmpty(initialHeaders)
                            ? {
                                headers: Object.assign(
                                    {
                                        'Accept-Ranges': 'bytes'
                                    },
                                    initialHeaders
                                )
                            }
                            : {
                                headers: {
                                    'Accept-Ranges': 'bytes'
                                }
                            }
                    )
                }

                app.get(
                    pathName,
                    useETag ? (handleCache as any) : (handleWithoutETag as any)
                )

                if (indexHTML && pathName.endsWith('/index.html'))
                    app.get(
                        pathName.replace('/index.html', ''),
                        useETag
                            ? (handleCache as any)
                            : (handleWithoutETag as any)
                    )
            }

        return app
    }

    if (
        // @ts-ignore private property
        !(`GET_${prefix}/*` in app.routeTree)
    ) {
        if (isBun) {
            const htmls = await listHTMLFiles(path.resolve(assets))

            for (const absolutePath of htmls) {
                if (!absolutePath || shouldIgnore(absolutePath)) continue

                let relativePath = absolutePath.replace(assetsDir, '')
                const pathName = path.join(prefix, relativePath)

                const htmlBundle = await import(absolutePath)

                app.get(pathName, htmlBundle.default)
                if (indexHTML && pathName.endsWith('/index.html'))
                    app.get(
                        pathName.replace('/index.html', ''),
                        htmlBundle.default
                    )
            }
        }

        app.onError(() => { }).get(
            `${prefix}/*`,
            async ({ params, headers: requestHeaders }) => {
                const pathName = path.join(
                    assets,
                    decodeURI
                        ? (fastDecodeURI(params['*']) ?? params['*'])
                        : params['*']
                )

                if (shouldIgnore(pathName)) throw new NotFoundError()

                const cache = fileCache.get(pathName)
                if (cache) return cache.clone()

                try {
                    const fileStat = await fs.stat(pathName).catch(() => null)
                    if (!fileStat) throw new NotFoundError()

                    if (!indexHTML && fileStat.isDirectory())
                        throw new NotFoundError()

                    // @ts-ignore
                    let file:
                        | NonNullable<Awaited<ReturnType<typeof getFile>>>
                        | undefined

                    let actualPath = pathName
                    let actualFileStat = fileStat

                    if (!isBun && indexHTML && fileStat.isDirectory()) {
                        const htmlPath = path.join(pathName, 'index.html')
                        const cache = fileCache.get(htmlPath)
                        if (cache) return cache.clone()

                        if (await fileExists(htmlPath)) {
                            actualPath = htmlPath
                            actualFileStat = await fs.stat(htmlPath)
                            file = await getFile(htmlPath)
                        }
                    }

                    if (
                        !file &&
                        !fileStat.isDirectory() &&
                        (await fileExists(pathName))
                    ) {
                        file = await getFile(pathName)
                        actualPath = pathName
                        actualFileStat = fileStat
                    } else if (!file) {
                        throw new NotFoundError()
                    }

                    // Check for range request
                    const rangeHeader = requestHeaders['range']
                    if (rangeHeader && actualFileStat) {
                        const fileSize = actualFileStat.size
                        const range = parseRange(rangeHeader, fileSize)

                        if (range) {
                            const rangeData = await getFileRange(actualPath, range)
                            if (rangeData) {
                                const etag = useETag ? await generateETag(file) : null

                                return new Response(rangeData, {
                                    status: 206,
                                    headers: Object.assign(
                                        {
                                            'Content-Range': formatContentRange(range, fileSize),
                                            'Cache-Control': maxAge
                                                ? `${directive}, max-age=${maxAge}`
                                                : directive,
                                            'Accept-Ranges': 'bytes'
                                        },
                                        initialHeaders,
                                        etag ? { Etag: etag } : {}
                                    )
                                })
                            }
                        }
                    }

                    const cache = fileCache.get(actualPath)
                    if (cache) return cache.clone()

                    if (!useETag)
                        return new Response(
                            file,
                            isNotEmpty(initialHeaders)
                                ? {
                                    headers: Object.assign(
                                        {
                                            'Accept-Ranges': 'bytes'
                                        },
                                        initialHeaders
                                    )
                                }
                                : {
                                    headers: {
                                        'Accept-Ranges': 'bytes'
                                    }
                                }
                        )

                    const etag = await generateETag(file)
                    if (
                        etag &&
                        (await isCached(requestHeaders, etag, pathName))
                    )
                        return new Response(null, {
                            status: 304
                        })

                    const response = new Response(file, {
                        headers: Object.assign(
                            {
                                'Cache-Control': maxAge
                                    ? `${directive}, max-age=${maxAge}`
                                    : directive,
                                'Accept-Ranges': 'bytes'
                            },
                            initialHeaders,
                            etag ? { Etag: etag } : {}
                        )
                    })

                    fileCache.set(pathName, response)

                    return response.clone()
                } catch (error) {
                    if (error instanceof NotFoundError) throw error
                    if (!silent) console.error(`[@elysiajs/static]`, error)

                    throw new NotFoundError()
                }
            }
        )
    }

    return app
}

export default staticPlugin
