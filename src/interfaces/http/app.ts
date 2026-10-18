/**
 * HTTP surface: the MCP endpoint (Streamable HTTP, stateless), a read API and
 * demo controls for the Resolution Lab, and the built web app.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Container } from '../../container.js';
import { SUBMISSION_OUTCOMES } from '../../application/demo-service.js';
import { DomainError, type DomainErrorCode } from '../../domain/errors.js';
import { buildMcpServer } from '../mcp/tools.js';

const WEB_DIST = fileURLToPath(new URL('../../../web/dist', import.meta.url));
const EVALUATION_RESULTS = fileURLToPath(
  new URL('../../../data/evaluation/results.json', import.meta.url),
);

const STATUS: Record<DomainErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  invalid_input: 400,
  illegal_transition: 409,
  approval_required: 409,
  approval_mismatch: 409,
  proposal_not_current: 409,
  duplicate_operation: 409,
  reconciliation_required: 409,
  retry_limit_reached: 409,
  conflict: 409,
  invalid_assessment: 500,
};

type Logger = Pick<Console, 'info' | 'warn' | 'error'>;

export function createHttpApp(container: Container, config: Config, logger: Logger = console) {
  const app = express();
  app.disable('x-powered-by');
  const customerRef = config.AFTERCARE_DEMO_CUSTOMER;

  const allowedHosts = new Set([
    `localhost:${config.PORT}`,
    `127.0.0.1:${config.PORT}`,
    `[::1]:${config.PORT}`,
    `${config.HOST}:${config.PORT}`,
  ]);
  const allowedOrigins = new Set([
    ...[...allowedHosts].map((h) => `http://${h}`),
    // Vite dev server for the web app.
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    ...config.AFTERCARE_ALLOWED_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  ]);
  for (const origin of config.AFTERCARE_ALLOWED_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean)) {
    try {
      allowedHosts.add(new URL(origin).host);
    } catch {
      logger.warn(`Ignoring invalid origin in AFTERCARE_ALLOWED_ORIGINS: ${origin}`);
    }
  }
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(config.HOST);

  // DNS-rebinding and cross-origin protection for every programmatic endpoint.
  const guard = (req: Request, res: Response, next: NextFunction) => {
    const host = req.headers.host ?? '';
    if (loopback && !allowedHosts.has(host)) {
      res.status(403).json({ error: { code: 'forbidden', message: 'Invalid Host header.' } });
      return;
    }
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      res.status(403).json({ error: { code: 'forbidden', message: 'Origin not allowed.' } });
      return;
    }
    if (config.AFTERCARE_ACCESS_TOKEN) {
      const header = req.headers.authorization ?? '';
      if (header !== `Bearer ${config.AFTERCARE_ACCESS_TOKEN}`) {
        res
          .status(401)
          .json({ error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } });
        return;
      }
    }
    next();
  };

  app.use(['/mcp', '/api'], guard, express.json({ limit: '64kb' }));

  // ---- MCP (Streamable HTTP, stateless: a fresh server and transport per request) ----
  app.post('/mcp', async (req: Request, res: Response) => {
    const server = buildMcpServer(container, customerRef);
    // No sessionIdGenerator: stateless mode, so no Mcp-Session-Id is issued.
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      // The SDK's transport type declares optional callbacks in a way exactOptionalPropertyTypes rejects.
      await server.connect(transport as unknown as Transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error('MCP request failed', error);
      if (!res.headersSent) {
        res
          .status(500)
          .json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
      }
    }
  });
  const methodNotAllowed = (_req: Request, res: Response) => {
    res
      .status(405)
      .set('Allow', 'POST')
      .json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed: this server is stateless.' },
        id: null,
      });
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  // ---- read API ----------------------------------------------------------------
  const wrap =
    (fn: (req: Request, res: Response) => Promise<unknown> | unknown) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = await fn(req, res);
        if (!res.headersSent) res.json(body);
      } catch (error) {
        next(error);
      }
    };

  app.get(
    '/api/health',
    wrap(() => ({ ok: true })),
  );

  app.get(
    '/api/session',
    wrap(() => ({
      customerRef,
      customerName: 'Maya (fictional demo customer)',
      caseDate: config.AFTERCARE_CASE_DATE ?? container.dataset.caseDate,
      retailer: { name: container.sandbox.name, simulated: container.sandbox.simulated },
      mcp: {
        endpoint: '/mcp',
        protocolVersion: LATEST_PROTOCOL_VERSION,
        transport: 'streamable-http (stateless)',
      },
      interpreter: 'rules@1',
    })),
  );

  app.get(
    '/api/cases',
    wrap(() => ({ cases: container.service.listCases(customerRef) })),
  );
  app.get(
    '/api/cases/:id',
    wrap((req) => container.service.getCase(String(req.params['id']), customerRef)),
  );
  app.get(
    '/api/cases/:id/assessments',
    wrap((req) => {
      const id = String(req.params['id']);
      container.service.getCase(id, customerRef); // ownership check
      return {
        assessments: container.repo.listAssessments(id).map((a) => ({
          id: a.id,
          createdAt: a.createdAt,
          nextStep: a.body.nextStep.kind,
          nextState: a.body.nextCaseState,
          headline: a.body.headline,
        })),
      };
    }),
  );

  app.get(
    '/api/evaluation',
    wrap(() => {
      if (!existsSync(EVALUATION_RESULTS)) return { available: false };
      return {
        available: true,
        results: JSON.parse(readFileSync(EVALUATION_RESULTS, 'utf8')) as unknown,
      };
    }),
  );

  // ---- demo controls (Resolution Lab) ---------------------------------------------------
  app.get(
    '/api/demo/sandbox',
    wrap(() => container.demo.sandboxState()),
  );
  app.post(
    '/api/demo/reset',
    wrap(() => container.demo.reset()),
  );
  const ScriptBody = z.object({
    outcome: z.enum(SUBMISSION_OUTCOMES),
    caseId: z.string().nullable().optional(),
  });
  app.post(
    '/api/demo/script',
    wrap((req) => {
      const body = ScriptBody.parse(req.body);
      container.demo.scriptNextSubmission(body.outcome, body.caseId ?? null);
      return container.demo.sandboxState();
    }),
  );
  app.post(
    '/api/demo/cases/:id/carrier-conflict',
    wrap((req) => container.demo.injectCarrierConflict(String(req.params['id']))),
  );
  app.post(
    '/api/demo/cases/:id/third-party-claim',
    wrap((req) => container.demo.injectThirdPartyClaim(String(req.params['id']))),
  );

  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: { code: 'not_found', message: 'No such endpoint.' } });
  });

  // ---- web app -----------------------------------------------------------------------
  if (config.SERVE_WEB && existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api|mcp).*/, (_req: Request, res: Response) => {
      res.sendFile('index.html', { root: WEB_DIST });
    });
  }

  // ---- errors ---------------------------------------------------------------------------
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof DomainError) {
      res.status(STATUS[error.code]).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: {
          code: 'invalid_input',
          message: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        },
      });
      return;
    }
    if (error instanceof SyntaxError) {
      res.status(400).json({ error: { code: 'invalid_input', message: 'Malformed JSON body.' } });
      return;
    }
    logger.error('Unhandled error', error);
    res
      .status(500)
      .json({
        error: {
          code: 'internal_error',
          message: 'Something went wrong on our side. Reload the case to see its current state.',
        },
      });
  });

  return app;
}
