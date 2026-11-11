import { requireFlowConfig } from "../lib/flow-config.ts";
import {
  requireActiveTask,
  requireIntegratorPlace,
  requireRoot,
} from "../lib/git.ts";
import { createOrca, sendFailMessage } from "../lib/orca.ts";
import { FlowError, type Command } from "../types.ts";

/** 統括役がタスク長に伝える */
export const run: Command = async (ctx) => {
  const [id, ...words] = ctx.argv;
  const text = words.join(" ").trim();
  if (!id || text === "")
    throw new FlowError(1, "使い方：orca-flow tell 〈ID〉 〈文〉");
  const root = await requireRoot(ctx.runner, ctx.cwd);
  const config = await requireFlowConfig(ctx.runner, root);
  await requireIntegratorPlace(ctx.runner, root, config);
  const task = await requireActiveTask(ctx.runner, root, config, id);
  const orca = createOrca(ctx.runner, root);
  const found = await orca.findSendTarget(task.path, config.lead.agent);
  if (found.kind !== "found")
    throw new FlowError(2, sendFailMessage(id, found, config.lead.agent));
  const terminal = found.terminal;
  const message = `（${config.integratorName}より）${text}`;
  await orca.sendText(terminal.handle, message);
  if (!ctx.json) ctx.stdout(`${id} に送りました：${message}`);
  return { code: 0, data: { id, terminal: terminal.handle, message } };
};
