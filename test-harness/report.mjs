/**
 * Readable end-to-end report. The suites under test/ are the machine-checked
 * part; this prints the same contract in a form a human can eyeball.
 *
 *   node test-harness/report.mjs [session.v4.jsonl.zstd]
 */
import { Context } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { createPlugin, projectionStatus } from 'dsh-tui-rewrite';
import { REWRITE_EVENT_TYPE } from 'dsh-tui-rewrite/projection';
import { loadSampleSession, textOf } from './tools.mjs';

const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
const line = text => process.stdout.write(text + '\n');

const { header, events } = loadSampleSession(process.argv[2]);
line('sample        : ' + events.length + ' events, cwd=' + header.cwd);

const root = new Context();
root.plugin(SessionStore);
await settle();
// No TUI seams here, so bound the late-mount polls: the production budget is
// ~10 minutes and this script must exit.
const host = root.plugin(createPlugin({ timers: { budgetMs: 200 } }));
await settle();
line('projection    : ' + JSON.stringify(projectionStatus()));
line('');

const session = root.sessions.create('report-probe', { seed: events, meta: { cwd: header.cwd } });
const targetSeq = events.find(event => event.type === 'assistant/message'
  && Array.isArray(event.data?.message?.content)
  && event.data.message.content.some(part => part.type === 'text')).seq;
const index = session.surface.nodes.indexOf(targetSeq);
const before = session.deriveMessages();

line('target        : seq ' + targetSeq + ' (model index ' + index + ')');
line('model sees    : ' + JSON.stringify(textOf(before[index]).slice(0, 70)));
line('log holds     : ' + JSON.stringify(textOf(session.eventAt(targetSeq).data.message).slice(0, 70)));
line('');

const NEW = '<< rewritten by dsh-tui-rewrite >>';
const event = session.append(REWRITE_EVENT_TYPE, { targetSeq, content: NEW });
const after = session.deriveMessages();

line('appended      : seq ' + event.seq + ' type=' + event.type);
line('model sees    : ' + JSON.stringify(textOf(after[index])));
line('log still has : ' + JSON.stringify(textOf(session.eventAt(targetSeq).data.message).slice(0, 70)));
line('messages      : ' + before.length + ' -> ' + after.length);
line('');

const neighboursSame = after.every((message, i) => i === index || JSON.stringify(message) === JSON.stringify(before[i]));
line('RESULT model-sees-rewrite      = ' + (textOf(after[index]) === NEW));
line('RESULT log-keeps-original      = ' + (textOf(session.eventAt(targetSeq).data.message) !== NEW));
line('RESULT neighbours-untouched    = ' + neighboursSame);
line('RESULT no-surfaceop-on-event   = ' + (event.surfaceOp === undefined && event.sourceEventSeqs === undefined));

await host.dispose();
await settle();
line('RESULT projection-unwound      = ' + (root.sessions.messageProjections.some(p => p.type === REWRITE_EVENT_TYPE) === false));
