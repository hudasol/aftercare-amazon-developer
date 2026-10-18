import { describe, expect, it } from 'vitest';
import { RulesInterpreter } from '../../src/infrastructure/interpreter/rules-interpreter.js';

const interpreter = new RulesInterpreter();

describe('RulesInterpreter', () => {
  it('reads the flagship request', async () => {
    const i = await interpreter.interpret(
      'My wireless headphones keep disconnecting. I bought them recently. Can you help me return them?',
    );
    expect(i).toMatchObject({
      goal: 'return',
      productQuery: 'wireless headphones',
      reason: 'defective',
      issueDescription: 'My wireless headphones keep disconnecting.',
      purchaseTimeHint: 'recently',
      serialNumber: null,
      soundsLikeApproval: false,
    });
  });

  it('extracts serial and order numbers', async () => {
    const i = await interpreter.interpret(
      'The serial is ha-7q2-4471 and the order was KG-1162-5821',
    );
    expect(i.serialNumber).toBe('HA-7Q2-4471');
    expect(i.orderNumber).toBe('KG-1162-5821');
  });

  it('recognises a change of mind', async () => {
    const i = await interpreter.interpret('Nothing is wrong with them, I just changed my mind.');
    expect(i.reason).toBe('changed_mind');
  });

  it('flags agreement without turning it into anything else', async () => {
    const i = await interpreter.interpret('Yes, go ahead!');
    expect(i.soundsLikeApproval).toBe(true);
    expect(i.goal).toBeNull();
  });

  it('distinguishes exchange from return', async () => {
    expect((await interpreter.interpret('Can I get a replacement for my earbuds?')).goal).toBe(
      'exchange',
    );
  });

  it('detects cancellation', async () => {
    expect((await interpreter.interpret('Never mind, close my case')).wantsToCancel).toBe(true);
    expect((await interpreter.interpret('Please cancel my return')).wantsToCancel).toBe(true);
  });

  it('never reads a fault description as cancellation', async () => {
    const i = await interpreter.interpret('They just stop working after a few minutes.');
    expect(i.reason).toBe('defective');
    expect(i.wantsToCancel).toBe(false);
    expect((await interpreter.interpret('Stop. They are broken.')).wantsToCancel).toBe(false);
  });
});
