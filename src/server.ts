import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { runPipeline } from './pipeline.js';
import type { Label } from './classify.js';
import { isTronAddress } from './wallet/tron.js';
import { isEvmAddress } from './wallet/evm.js';

export const app = new Hono();

app.use('*', async (c, next) => {
  await next();
  c.header('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
});

// Simple per-IP limit: 20 reports a minute.
const hits = new Map<string, number[]>();
function limited(ip: string): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter(t => now - t < 60_000);
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > 20;
}

app.get('/healthz', c => c.json({ ok: true }));

// Big wallets can take longer than the hosting gateway allows (about 60s), so a report
// runs as a job: we wait up to 20s, then hand back a job id the page polls.
type Job = { at: number; done: boolean; result?: unknown; status?: number };
const jobs = new Map<string, Job>();
const JOB_TTL = 30 * 60_000;
function sweepJobs() { const now = Date.now(); for (const [k, j] of jobs) if (now - j.at > JOB_TTL) jobs.delete(k); }

app.get('/api/report/:id', c => {
  const j = jobs.get(c.req.param('id'));
  if (!j) return c.json({ error: 'That report expired. Run it again.' }, 404);
  if (!j.done) return c.json({ pending: true, id: c.req.param('id') }, 202);
  return c.json(j.result as object, (j.status ?? 200) as 200);
});

app.post('/api/report', async c => {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? 'local';
  if (limited(ip)) return c.json({ error: 'Too many requests. Wait a minute and try again.' }, 429);
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > 200_000) return c.json({ error: 'Request too large.' }, 413);
  const body = await c.req.json().catch(() => null) as any;
  if (!body) return c.json({ error: 'Send JSON.' }, 400);
  const wallets: string[] = [...new Set<string>((Array.isArray(body.wallets) ? body.wallets : []).map((w: unknown) => String(w).trim()).filter(Boolean))];
  if (!wallets.length) return c.json({ error: 'Add at least one wallet address.' }, 400);
  if (wallets.length > 5) return c.json({ error: 'Up to 5 wallets per report.' }, 400);
  const bad = wallets.filter(w => !isTronAddress(w) && !isEvmAddress(w));
  if (bad.length) return c.json({ error: `Not a Tron (T…) or EVM (0x…) address: ${bad.join(', ')}` }, 400);
  const year = Number(body.year ?? 2026);
  if (![2025, 2026].includes(year)) return c.json({ error: 'Year must be 2025 or 2026.' }, 400);
  const labels = (body.labels && typeof body.labels === 'object') ? body.labels as Record<string, Label> : {};
  const other = Math.max(0, Number(body.otherIncome ?? 0) || 0);
  const id = createHash('sha256').update(JSON.stringify([wallets.slice().sort(), year, labels, other, body.method])).digest('hex').slice(0, 24);
  sweepJobs();
  let job = jobs.get(id);
  if (!job || (job.done && job.status !== 200)) {
    job = { at: Date.now(), done: false };
    jobs.set(id, job);
    const j = job;
    build(wallets, year, labels, other, body).then(r => { j.result = r.body; j.status = r.status; j.done = true; });
  }
  const started = Date.now();
  while (!job.done && Date.now() - started < 20_000) await new Promise(r => setTimeout(r, 250));
  if (!job.done) return c.json({ pending: true, id }, 202);
  return c.json(job.result as object, (job.status ?? 200) as 200);
});

async function build(wallets: string[], year: number, labels: Record<string, Label>, other: number, body: any): Promise<{ status: number; body: unknown }> {
  try {
    const out = await runPipeline({ wallets, year, labels, otherChargeableNaira: other, method: body.method === 'WAC' ? 'WAC' : 'FIFO' });
    const inYear = (d: string) => d.startsWith(String(year));
    return { status: 200, body: {
      year,
      totals: out.report.totals,
      estimate: out.estimate,
      rows: out.classified.rows.filter(r => inYear(r.move.date)).map(r => ({
        id: r.id, date: r.move.date, chain: r.move.chain, hash: r.move.hash, direction: r.move.direction,
        symbol: r.move.symbol, units: r.move.units, usd: r.usd, counterparty: r.move.counterparty,
        label: r.label, guessed: !body.labels?.[r.id], reason: r.reason, swap: !!r.swapWith,
      })),
      disposals: out.report.disposals,
      income: out.report.income,
      unpriced: out.classified.unpriced.length,
      spam: out.classified.spam,
      needsReview: out.classified.rows.filter(r => !r.label && inYear(r.move.date)).length,
      warnings: [...out.report.warnings, ...out.errors],
      rateNotes: out.rateNotes.length,
      sources: out.sources,
    } };
  } catch (e) {
    return { status: 502, body: { error: `Could not build the report: ${(e as Error).message}` } };
  }
}

app.use('/*', serveStatic({ root: './public' }));

if (process.env.NODE_ENV !== 'test') {
  const port = Number(process.env.PORT ?? 8080);
  serve({ fetch: app.fetch, port });
  console.log(`listening on ${port}`);
}
