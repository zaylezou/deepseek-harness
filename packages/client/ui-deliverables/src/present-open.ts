/** Serve change summaries, comparisons, downloads, and native opens of declared or changed files. */
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-api-workspace-files'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-session-query'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { PresentedFile } from '@deepseek-ai/dsh-tool-present/types'
import { CHANGES_DIFF_PATH, CHANGES_OPEN_PATH, CHANGED_FILES_PATH, type ChangesSummary } from './changes.ts'
import { basename, isPresentedData, isPresentedFile, PRESENT_DOWNLOAD_PATH, PRESENT_HOST_PATH, PRESENT_OPEN_PATH, type PresentedHost } from './presented.ts'

/**
 * Register the deliverables routes inside Connection's authentication fence:
 * desktop metadata, change summaries and comparisons, declared-file downloads
 * and actions, and changed-file opening.
 * @param ctx - Session lookup, change summaries, native opener, and route lifetime.
 */
export function registerPresentOpen(ctx: Context): void {
  ctx.connection.fetch.register({
    path: PRESENT_HOST_PATH, methods: ['GET'], requestBody: 'buffered',
    fetch: () => Promise.resolve(Response.json(ctx.sessionController.workspaceDesktop() satisfies PresentedHost,
      { headers: { 'cache-control': 'no-store' } })),
  })
  ctx.connection.fetch.register({
    path: CHANGED_FILES_PATH, methods: ['GET'], requestBody: 'buffered',
    fetch: request => Promise.resolve(handleChangesSummary(ctx, request)),
  })
  const lifetime = new AbortController()
  const pending = new Set<Promise<Response>>()
  ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.allSettled(pending)
  })
  const routes = [
    [PRESENT_DOWNLOAD_PATH, ['GET'], handlePresentDownload], [PRESENT_OPEN_PATH, ['GET', 'POST'], handlePresentOpen], [CHANGES_OPEN_PATH, ['GET', 'POST'], handleChangesOpen], [CHANGES_DIFF_PATH, ['GET'], handleChangesDiff],
  ] as const
  for (const [path, methods, handler] of routes) {
    ctx.connection.fetch.register({
      path,
      methods: [...methods],
      requestBody: 'buffered',
      fetch: (request) => {
        const task = handler(ctx, new Request(request, {
          signal: AbortSignal.any([request.signal, lifetime.signal]),
        }))
        pending.add(task)
        void task.then(() => { pending.delete(task) }, () => { pending.delete(task) })
        return task
      },
    })
  }
}

const NUMERIC = /^\d+$/

function coordinate(value: string | null): number | undefined {
  return value !== null && NUMERIC.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined
}

/** Translate lookup and filesystem failures into the not-found or failure status the browser retries from. */
function failureStatus(error: unknown): number {
  const remote = remoteErrorOf(error)
  const missing = remote?.code === 'session/not-found' || remote?.code === 'workspace-file/not-found'
    || remote?.code === 'workspace-file/not-regular-file' || error instanceof Error && 'code' in error
    && (error.code === 'SESSION_QUERY_SESSION_NOT_FOUND' || error.code === 'SESSION_QUERY_EVENT_NOT_FOUND'
      || error.code === 'ENOENT' || error.code === 'ENOTDIR')
  return missing ? 404 : 500
}

/**
 * Read the addressed event, refusing a Host without a desktop when the gesture
 * needs one; a browser download never does.
 * @param requireDesktop - whether this gesture needs the Host's native opener.
 * @returns the event with its Session header, or the refusal to answer with.
 */
async function readTarget(ctx: Context, request: Request, id: string, seq: number, requireDesktop: boolean): Promise<Awaited<ReturnType<Context['sessionQuery']['readEvent']>> | Response> {
  request.signal.throwIfAborted()
  if (requireDesktop && !ctx.sessionController.workspaceDesktop().available) return new Response('Host desktop unavailable.', { status: 409 })
  return ctx.sessionQuery.readEvent({ sessionId: id as SessionId, seq: seq as SessionSeq, before: 0, after: 0 }, request.signal)
}

/**
 * Resolve one Host path to its filesystem target. A path with no Host mapping,
 * or one that does not resolve back to itself, never reaches a reader.
 * @returns the resolved target, or the 422 to answer with.
 */
async function verifiedTarget(ctx: Context, request: Request, path: string): Promise<FsTarget | Response> {
  const mapped = ctx.fs.processPathFromHostPath(path)
  if (mapped === undefined) return new Response('Path has no verified Host path.', { status: 422 })
  const target = await ctx.fs.resolve(mapped, { signal: request.signal })
  return ctx.fs.processPath(target) === path ? target : new Response('Path has no verified Host path.', { status: 422 })
}

/**
 * Open one verified Host path. A file is verified through the Session
 * filesystem; a directory is verified by the Host filesystem mapping alone.
 * @returns the HTTP status to answer with.
 */
async function openVerified(ctx: Context, request: Request, path: string, action: 'open' | 'reveal'): Promise<Response> {
  const verified = await verifiedTarget(ctx, request, path)
  if (verified instanceof Response) return verified
  request.signal.throwIfAborted()
  if (request.method === 'GET') {
    return Response.json(await ctx.sessionController.workspacePathApplications({ path }, request.signal),
      { headers: { 'cache-control': 'no-store' } })
  }
  const application = new URL(request.url).searchParams.get('application')
  await ctx.sessionController.openWorkspacePath({ path, ...(action === 'reveal' ? { action }
    : application === null ? {} : { application }) }, request.signal)
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
}

/**
 * Resolve the file one declaration names: the addressed event, the recorded
 * declaration, and the viewed Session's current workspace path for it.
 * @param requireDesktop - whether this gesture needs the Host's native opener.
 * @returns the declaration with its Host path, or the refusal to answer with.
 */
async function resolveDeclaredFile(
  ctx: Context, request: Request, id: string, seq: number, index: number,
  requireDesktop: boolean,
): Promise<{ file: PresentedFile; path: string } | Response> {
  const read = await readTarget(ctx, request, id, seq, requireDesktop)
  if (read instanceof Response) return read
  const { target, session } = read
  const file = target.type === 'deliverables/presented' && isPresentedData(target.data) ? target.data.files[index] : undefined
  if (!isPresentedFile(file)) return new Response('Presented file not found in this Session result.', { status: 404 })
  request.signal.throwIfAborted()
  const { absolutePath: path } = await ctx.workspaceFiles.stat({
    sessionId: id as SessionId,
    workspaceRoot: session.cwd ?? ctx.sandboxPolicy.workspaceRoot,
  }, file.path, request.signal)
  return { file, path }
}

async function handlePresentOpen(ctx: Context, request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams
  const action = query.get('action') ?? 'open'
  if (action !== 'open' && action !== 'reveal') return new Response('Invalid file action.', { status: 400 })
  const id = query.get('sessionId')
  const seq = coordinate(query.get('seq'))
  const index = coordinate(query.get('index'))
  if (!id || seq === undefined || index === undefined) return new Response('Invalid Presented file coordinates.', { status: 400 })
  try {
    const declared = await resolveDeclaredFile(ctx, request, id, seq, index, true)
    if (declared instanceof Response) return declared
    return await openVerified(ctx, request, declared.path, action)
  } catch (error: unknown) {
    request.signal.throwIfAborted()
    return new Response('Presented file unavailable.', { status: failureStatus(error) })
  }
}

/**
 * Media types a delivered workspace file downloads as, keyed by lowercase
 * extension without the dot. A download is still always an attachment; the type
 * only tells the browser, the OS, and the Android shell what the bytes are, so a
 * PDF or a PNG is not mistaken for an installable package.
 */
const DOWNLOAD_MEDIA_TYPES: Readonly<Record<string, string>> = {
  apk: 'application/vnd.android.package-archive',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  zip: 'application/zip',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  epub: 'application/epub+zip',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  jsonl: 'application/x-ndjson; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  yaml: 'application/yaml; charset=utf-8',
  yml: 'application/yaml; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  py: 'text/x-python; charset=utf-8',
  ts: 'text/plain; charset=utf-8',
  sh: 'text/x-shellscript; charset=utf-8',
  sql: 'application/sql; charset=utf-8',
}

/**
 * Resolve a download's media type from its file name.
 * @param name - the declared file's basename or path.
 * @returns the mapped media type, or the binary default for anything unmapped.
 */
function downloadMediaType(name: string): string {
  const at = name.lastIndexOf('.')
  if (at === -1 || at === name.length - 1) return 'application/octet-stream'
  return DOWNLOAD_MEDIA_TYPES[name.slice(at + 1).toLowerCase()] ?? 'application/octet-stream'
}

/** One read of a streaming download: bounded per request so a large file never buffers whole. */
const DOWNLOAD_CHUNK_BYTES = 1 << 20

/**
 * Encode a file name for a `filename*` parameter: percent-escaped UTF-8 with the
 * characters `encodeURIComponent` leaves alone that would end the header value
 * early or read as parameters.
 * @param name - the declared file's basename.
 * @returns the RFC 5987 value.
 */
function encodedFilename(name: string): string {
  return encodeURIComponent(name.toWellFormed())
    .replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

/**
 * Content-Disposition that a simple parser still names correctly. Android's
 * URLUtil.guessFileName (and other naive clients) read only the quoted ASCII
 * `filename` parameter and ignore RFC 5987 `filename*`, so a non-ASCII declared
 * name would fall back to the route's last path segment. Both forms travel
 * together: the quoted one is an ASCII-safe stand-in, the starred one is exact.
 * @param path - the declared file's path.
 * @returns the header value naming the saved file.
 */
function attachmentDisposition(path: string): string {
  const name = basename(path)
  const fallback = name.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\]/gu, '_') || 'download'
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodedFilename(name)}`
}

/** Read a verified file in bounded windows, ending on the first short read. */
async function* fileChunks(fs: Context['fs'], target: FsTarget, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  let offset = 0
  for (;;) {
    const chunk = await fs.readByteRange(target, { offset, length: DOWNLOAD_CHUNK_BYTES }, signal)
    if (chunk.byteLength === 0) return
    offset += chunk.byteLength
    yield chunk
  }
}

/**
 * Stream one declared workspace file to the browser as an attachment. The
 * declaration resolves through the viewed Session's filesystem and the Host
 * path mapping exactly like a native open, but a browser needs neither a
 * desktop nor any copied snapshot: the bytes are the current workspace source.
 * @returns the streamed download, or the refusal to answer with.
 */
async function handlePresentDownload(ctx: Context, request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams
  const id = query.get('sessionId')
  const seq = coordinate(query.get('seq'))
  const index = coordinate(query.get('index'))
  if (!id || seq === undefined || index === undefined) return new Response('Invalid Presented file coordinates.', { status: 400 })
  try {
    const declared = await resolveDeclaredFile(ctx, request, id, seq, index, false)
    if (declared instanceof Response) return declared
    const verified = await verifiedTarget(ctx, request, declared.path)
    if (verified instanceof Response) return verified
    const info = await ctx.fs.stat(verified, request.signal)
    if (info?.type !== 'file') return new Response('Presented file unavailable.', { status: 404 })
    const stream = Readable.from(fileChunks(ctx.fs, verified, request.signal), { signal: request.signal })
    const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>
    return new Response(body, {
      headers: {
        'content-type': downloadMediaType(declared.file.path),
        'content-disposition': attachmentDisposition(declared.file.path),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    })
  } catch (error: unknown) {
    request.signal.throwIfAborted()
    return new Response('Presented file unavailable.', { status: failureStatus(error) })
  }
}

/** The summary one `workspace/changes` event announced, without the Host working directory; 404 once the Host no longer serves it. */
function handleChangesSummary(ctx: Context, request: Request): Response {
  const query = new URL(request.url).searchParams
  const id = query.get('sessionId')
  const seq = coordinate(query.get('seq'))
  if (!id || seq === undefined) return new Response('Invalid change summary coordinates.', { status: 400 })
  const summary = ctx.workspaceChanges.summary(id as SessionId, seq)
  if (summary === undefined) return new Response('Change summary unavailable.', { status: 404 })
  const { turn, files, total, added, deleted } = summary
  return Response.json({ turn, files, total, added, deleted } satisfies ChangesSummary, { headers: { 'cache-control': 'no-store' } })
}

/** A changed file's coordinates from a route query, or the 400 to answer with. */
function changedFileCoordinates(request: Request): { id: SessionId; seq: number; index: number } | Response {
  const query = new URL(request.url).searchParams
  const id = query.get('sessionId')
  const seq = coordinate(query.get('seq'))
  const index = coordinate(query.get('index'))
  if (!id || seq === undefined || index === undefined) return new Response('Invalid changed file coordinates.', { status: 400 })
  return { id: id as SessionId, seq, index }
}

/** One listed file's comparison; 404 once the Host no longer serves the summary or the index names no file. */
async function handleChangesDiff(ctx: Context, request: Request): Promise<Response> {
  const coordinates = changedFileCoordinates(request)
  if (coordinates instanceof Response) return coordinates
  const { id, seq, index } = coordinates
  try {
    const diff = await ctx.workspaceChanges.diff(id, seq, index, request.signal)
    if (diff === undefined) return new Response('Change comparison unavailable.', { status: 404 })
    return Response.json(diff, { headers: { 'cache-control': 'no-store' } })
  } catch (error: unknown) {
    request.signal.throwIfAborted()
    return new Response('Change comparison unavailable.', { status: failureStatus(error) })
  }
}

async function handleChangesOpen(ctx: Context, request: Request): Promise<Response> {
  const action = new URL(request.url).searchParams.get('action') ?? 'open'
  if (action !== 'open' && action !== 'reveal') return new Response('Invalid file action.', { status: 400 })
  const coordinates = changedFileCoordinates(request)
  if (coordinates instanceof Response) return coordinates
  const { id, seq, index } = coordinates
  try {
    request.signal.throwIfAborted()
    if (!ctx.sessionController.workspaceDesktop().available) return new Response('Host desktop unavailable.', { status: 409 })
    const changes = ctx.workspaceChanges.summary(id, seq)
    if (changes === undefined) return new Response('Change summary unavailable.', { status: 404 })
    const workspaceRoot = changes.cwd
    const file = changes.files[index]
    if (file === undefined) return new Response('Changed file not found in this summary.', { status: 404 })
    const { absolutePath: path } = await ctx.workspaceFiles.stat({ sessionId: id, workspaceRoot }, file.path, request.signal)
    return await openVerified(ctx, request, path, action)
  } catch (error: unknown) {
    request.signal.throwIfAborted()
    return new Response('Changed file unavailable.', { status: failureStatus(error) })
  }
}
