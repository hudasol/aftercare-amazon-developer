/**
 * AFTERCARE's MCP tools.
 *
 * These are the operations an assistant such as Alexa+ would call. Each tool
 * validates its input, calls the same ResolutionService the web app uses, and
 * returns a structured result with a short `speech` line for voice and a
 * `display` card for screens.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { Container } from '../../container.js';
import { DomainError } from '../../domain/errors.js';
import { money, date } from '../../domain/narrative.js';
import type { CaseView } from '../../application/views.js';

export const SERVER_INFO = {
  name: 'aftercare',
  title: 'AFTERCARE purchase resolution',
  version: '1.0.0',
};

const CaseResult = {
  caseId: z.string(),
  state: z.string(),
  stateLabel: z.string(),
  headline: z.string(),
  speech: z.string().describe('One or two short sentences suitable for a voice response.'),
  message: z.string().describe('The full reply to show the customer.'),
  nextStep: z.object({
    kind: z.string(),
    requiresApproval: z.boolean(),
    rationale: z.string(),
  }),
  lifecycle: z.object({ stage: z.string(), label: z.string(), detail: z.string() }),
  proposal: z
    .object({
      proposalId: z.string(),
      proposalDigest: z
        .string()
        .describe('Pass this back unchanged to approve exactly this proposal.'),
      status: z.string(),
      summary: z.string(),
      orderId: z.string(),
      productName: z.string(),
      refund: z.string(),
      returnShipping: z.enum(['prepaid_label', 'customer_paid']),
      returnBy: z.string(),
      policyVersion: z.string(),
    })
    .nullable(),
  needsFromCustomer: z.array(z.object({ id: z.string(), label: z.string(), why: z.string() })),
  blockers: z.array(z.object({ title: z.string(), explanation: z.string() })),
  operation: z
    .object({
      operationId: z.string(),
      status: z.string(),
      retailerReference: z.string().nullable(),
    })
    .nullable(),
  display: z.object({
    title: z.string(),
    subtitle: z.string(),
    rows: z.array(z.object({ label: z.string(), value: z.string() })),
  }),
  retailerIsSimulated: z
    .boolean()
    .describe('True: the retailer is the fictional Kestrel Goods sandbox.'),
};

type CaseResultValue = z.infer<z.ZodObject<typeof CaseResult>>;

export function toCaseResult(view: CaseView): CaseResultValue {
  const a = view.assessment;
  const proposal =
    [...view.proposals].reverse().find((p) => p.status === 'prepared' || p.status === 'approved') ??
    null;
  const operation = view.operations.at(-1) ?? null;
  const lastReply = [...view.messages].reverse().find((m) => m.role === 'assistant');
  const rows: { label: string; value: string }[] = [
    { label: 'Status', value: view.case.stateLabel },
  ];
  if (a?.subject.orderId) rows.push({ label: 'Order', value: a.subject.orderId });
  if (a?.policy.governingVersion)
    rows.push({ label: 'Policy', value: `v${a.policy.governingVersion}` });
  if (a?.eligibility.deadline) {
    rows.push({
      label: a.eligibility.status === 'eligible' ? 'Return by' : 'Window closed',
      value: date(a.eligibility.deadline),
    });
  }
  if (operation?.externalRef)
    rows.push({ label: 'Retailer reference', value: operation.externalRef });
  return {
    caseId: view.case.id,
    state: view.case.state,
    stateLabel: view.case.stateLabel,
    headline: a?.headline ?? view.case.title,
    speech: a?.nextStep.speech ?? view.case.stateLabel,
    message: lastReply?.text ?? '',
    nextStep: {
      kind: a?.nextStep.kind ?? 'none',
      requiresApproval: a?.nextStep.requiresApproval ?? false,
      rationale: a?.nextStep.rationale ?? '',
    },
    lifecycle: {
      stage: view.lifecycle.stage,
      label: view.lifecycle.label,
      detail: view.lifecycle.detail,
    },
    proposal: proposal
      ? {
          proposalId: proposal.id,
          proposalDigest: proposal.digest,
          status: proposal.status,
          summary: `Return ${proposal.parameters.productName} (order ${proposal.parameters.orderId}) for a ${money(proposal.parameters.refundAmountCents, proposal.parameters.currency)} refund, ${proposal.parameters.returnShipping === 'prepaid_label' ? 'prepaid label' : 'customer pays shipping'}.`,
          orderId: proposal.parameters.orderId,
          productName: proposal.parameters.productName,
          refund: money(proposal.parameters.refundAmountCents, proposal.parameters.currency),
          returnShipping: proposal.parameters.returnShipping,
          returnBy: proposal.parameters.returnBy,
          policyVersion: proposal.parameters.policyVersion,
        }
      : null,
    needsFromCustomer: (a?.missing ?? [])
      .filter((m) => m.obtainableFrom === 'customer' && m.blocking)
      .map((m) => ({ id: m.id, label: m.label, why: m.why })),
    blockers: (a?.blockers ?? []).map((b) => ({
      title: b.title,
      explanation: b.customerExplanation,
    })),
    operation: operation
      ? {
          operationId: operation.id,
          status: operation.status,
          retailerReference: operation.externalRef,
        }
      : null,
    display: { title: a?.headline ?? view.case.title, subtitle: view.case.title, rows },
    retailerIsSimulated: true,
  };
}

function toDecisionTrace(view: CaseView) {
  const a = view.assessment;
  return {
    caseId: view.case.id,
    caseDate: view.case.asOf,
    decision: a?.nextStep.kind ?? 'none',
    rationale: a?.nextStep.rationale ?? '',
    evidence: view.evidence.map((e) => ({
      id: e.id,
      title: e.title,
      source: `${e.source.name} (${e.source.type})`,
      verification: e.verification,
      status: e.status,
      simulated: e.simulated,
    })),
    governingPolicy: a?.policy.governingVersion ?? null,
    policyRule: a?.policy.rule ?? '',
    eligibility: a?.eligibility.explanation ?? '',
    conflicts: (a?.conflicts ?? []).map(
      (c) => `${c.label}: ${c.kind.replaceAll('_', ' ')}. ${c.explanation}`,
    ),
    actions: (a?.candidates ?? []).map((c) => `${c.label}: ${c.status}. ${c.reason}`),
    trace: (a?.trace ?? []).map((t) => `${t.stage}: ${t.outcome}. ${t.detail}`),
  };
}

const DecisionTrace = {
  caseId: z.string(),
  caseDate: z.string(),
  decision: z.string(),
  rationale: z.string(),
  evidence: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      source: z.string(),
      verification: z.string(),
      status: z.string(),
      simulated: z.boolean(),
    }),
  ),
  governingPolicy: z.string().nullable(),
  policyRule: z.string(),
  eligibility: z.string(),
  conflicts: z.array(z.string()),
  actions: z.array(z.string()),
  trace: z.array(z.string()),
};

const CaseList = {
  cases: z.array(
    z.object({
      caseId: z.string(),
      title: z.string(),
      state: z.string(),
      stateLabel: z.string(),
      headline: z.string().nullable(),
      updatedAt: z.string(),
    }),
  ),
};

function errorResult(error: unknown) {
  const body =
    error instanceof DomainError
      ? { code: error.code, message: error.message }
      : { code: 'internal_error', message: 'The tool failed unexpectedly.' };
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ error: body }) }],
  };
}

/** Build a server instance for one request. Tools act for `customerRef`. */
export function buildMcpServer(container: Container, customerRef: string): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      'AFTERCARE resolves post-purchase problems as persistent cases. Start with start_return_case. ' +
      'Read `speech` aloud and show `display`. Only call approve_proposed_return after the customer has heard or seen ' +
      'the exact proposal and explicitly confirmed it; never infer approval. After submit_approved_return, call ' +
      'check_return_outcome until the lifecycle stage is "confirmed", "refused" or the case needs review. ' +
      'The retailer (Kestrel Goods) is a fictional simulation.',
  });
  const { service, repo } = container;
  const ctx = { customerRef, channel: 'mcp_client' as const };

  const caseTool = <A extends z.ZodRawShape>(
    name: string,
    config: {
      title: string;
      description: string;
      inputSchema: A;
      annotations?: Record<string, boolean>;
    },
    run: (args: z.infer<z.ZodObject<A>>) => Promise<CaseView>,
  ) => {
    server.registerTool(
      name,
      { ...config, outputSchema: CaseResult },
      // The SDK validates `args` against inputSchema before this runs.
      (async (args: z.infer<z.ZodObject<A>>) => {
        try {
          const view = await run(args);
          repo.transaction(() =>
            repo.appendEvent(
              {
                caseId: view.case.id,
                type: 'mcp.tool_called',
                actor: 'mcp_client',
                summary: `MCP tool ${name} called.`,
                data: { tool: name },
              },
              new Date().toISOString(),
            ),
          );
          const result = toCaseResult(view);
          return {
            content: [{ type: 'text' as const, text: result.speech }],
            structuredContent: result,
          };
        } catch (error) {
          // Refusals on an existing case belong in its audit trail too.
          const caseId = (args as { caseId?: unknown }).caseId;
          const owned = typeof caseId === 'string' ? repo.getCase(caseId) : null;
          if (owned && owned.customerRef === customerRef && error instanceof DomainError) {
            repo.transaction(() =>
              repo.appendEvent(
                {
                  caseId: owned.id,
                  type: 'mcp.tool_refused',
                  actor: 'mcp_client',
                  summary: `MCP tool ${name} refused: ${error.message}`,
                  data: { tool: name, code: error.code },
                },
                new Date().toISOString(),
              ),
            );
          }
          return errorResult(error);
        }
      }) as never,
    );
  };

  caseTool(
    'start_return_case',
    {
      title: 'Start a purchase-resolution case',
      description:
        'Open a persistent case from the customer’s own words (for example "my headphones keep disconnecting, can I return them?"). AFTERCARE looks up the orders and the governing return policy and says what can safely happen next.',
      inputSchema: {
        customerRequest: z.string().min(3).max(2000).describe('What the customer said, verbatim.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => service.openCase({ ...ctx, utterance: args.customerRequest }),
  );

  caseTool(
    'continue_case',
    {
      title: 'Add what the customer said to a case',
      description:
        'Pass the customer’s next message (an answer, a correction, a serial or order number). Agreement in conversation is never treated as approval.',
      inputSchema: {
        caseId: z.string().min(1),
        customerMessage: z.string().min(1).max(2000),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => service.sendMessage({ ...ctx, caseId: args.caseId, utterance: args.customerMessage }),
  );

  caseTool(
    'provide_item_serial',
    {
      title: 'Provide the item’s serial number',
      description:
        'Checks the serial against the retailer’s shipment records to identify exactly which item the customer has.',
      inputSchema: {
        caseId: z.string().min(1),
        serialNumber: z.string().regex(/^[A-Za-z0-9-]{4,32}$/),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) =>
      service.provideSerial({ ...ctx, caseId: args.caseId, serialNumber: args.serialNumber }),
  );

  caseTool(
    'approve_proposed_return',
    {
      title: 'Record the customer’s approval of a proposed return',
      description:
        'Call ONLY after the customer explicitly approved the exact proposal returned by this server. The approval binds to proposalDigest; if the case changed since, it is refused. Approving does not submit anything.',
      inputSchema: {
        caseId: z.string().min(1),
        proposalId: z.string().min(1),
        proposalDigest: z.string().regex(/^[a-f0-9]{64}$/),
        customerConfirmation: z
          .string()
          .min(2)
          .max(500)
          .describe('The customer’s words of approval, verbatim.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args) =>
      service.approve({
        ...ctx,
        caseId: args.caseId,
        proposalId: args.proposalId,
        digest: args.proposalDigest,
        statement: args.customerConfirmation,
      }),
  );

  caseTool(
    'decline_proposed_return',
    {
      title: 'Decline a proposed return',
      description:
        'The customer does not want the proposed return. Closes the case; nothing is submitted.',
      inputSchema: { caseId: z.string().min(1), proposalId: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (args) => service.decline({ ...ctx, caseId: args.caseId, proposalId: args.proposalId }),
  );

  caseTool(
    'submit_approved_return',
    {
      title: 'Submit an approved return to the retailer',
      description:
        'Submits an approved proposal to the (simulated) retailer. Refuses if not approved, if already submitted, or while a previous outcome is unknown. A successful call means "submitted", not "confirmed": call check_return_outcome next.',
      inputSchema: { caseId: z.string().min(1), proposalId: z.string().min(1) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args) => service.execute({ ...ctx, caseId: args.caseId, proposalId: args.proposalId }),
  );

  caseTool(
    'check_return_outcome',
    {
      title: 'Check what happened to a submitted return',
      description:
        'Reconciles an unknown outcome by looking the request up at the retailer, or verifies an accepted return against the approved terms. Never resubmits.',
      inputSchema: { caseId: z.string().min(1) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args) => service.checkOutcome({ ...ctx, caseId: args.caseId }),
  );

  caseTool(
    'get_case',
    {
      title: 'Get a case',
      description: 'Resume a case: its state, latest decision, proposal and operation status.',
      inputSchema: { caseId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => service.getCase(args.caseId, customerRef),
  );

  server.registerTool(
    'list_my_cases',
    {
      title: 'List my cases',
      description: 'The customer’s cases, most recently updated first, for resuming one.',
      inputSchema: {},
      outputSchema: CaseList,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const cases = service.listCases(customerRef).map((c) => ({
        caseId: c.id,
        title: c.title,
        state: c.state,
        stateLabel: c.stateLabel,
        headline: c.headline,
        updatedAt: c.updatedAt,
      }));
      const text = cases.length
        ? `${cases.length} case(s). Most recent: ${cases[0]?.title} (${cases[0]?.stateLabel}).`
        : 'No cases yet.';
      return { content: [{ type: 'text', text }], structuredContent: { cases } };
    },
  );

  server.registerTool(
    'explain_decision',
    {
      title: 'Explain the current decision',
      description:
        'The auditable decision trace: evidence with sources, governing policy, conflicts, and why each action is allowed or blocked.',
      inputSchema: { caseId: z.string().min(1) },
      outputSchema: DecisionTrace,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ caseId }) => {
      try {
        const trace = toDecisionTrace(service.getCase(caseId, customerRef));
        return {
          content: [{ type: 'text', text: trace.rationale || trace.decision }],
          structuredContent: trace,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}
