import { DurableObject } from 'cloudflare:workers';
import initial from '../data/notes.json' with { type: 'json' };
import { NotebookService } from './notebook.js';

export class Notebook extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.service = new NotebookService(ctx.storage, env, initial);
  }
  fetch(request) { return this.service.fetch(request); }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin');
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
    if (origin && !allowed.includes(origin)) return new Response('Origin not allowed', { status: 403 });
    const headers = {
      'Vary': 'Origin',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '600'
    };
    if (origin) headers['Access-Control-Allow-Origin'] = origin;
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const forwarded = new Request(request);
    // Overwrite this header so clients cannot choose another login throttle key.
    forwarded.headers.set('x-notes-client', request.headers.get('cf-connecting-ip') || 'local');
    const notebook = env.NOTEBOOK.get(env.NOTEBOOK.idFromName('public-notebook-v1'));
    try {
      const response = await notebook.fetch(forwarded);
      return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...headers } });
    } catch {
      return Response.json({ message: '笔记服务暂时无法连接，请稍后重试。', code: 'network' }, { status: 503, headers });
    }
  }
};
