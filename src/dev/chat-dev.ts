/**
 * DEV-only console harness for validating the cross-drive Graph surface
 * with two real consumer accounts before any chat UI exists (and after,
 * for the runbook's Graph validation steps). Loaded from main.ts under
 * import.meta.env.DEV; never part of a production build.
 *
 * Usage from the browser console (signed in):
 *   const dev = window.__milkboxChatDev
 *   const me = await dev.getMe()
 *   const chat = await dev.createChatFolder('probe', me)        // host account
 *   const link = await dev.createInviteLink(chat)               // consent prompt expected once
 *   dev.encodeShareUrl(link.webUrl)                             // → token for the guest
 *   // On the guest account:
 *   const found = await dev.resolveSharedChat('<token>')
 *   await dev.runDelta({ kind:'chat', chatId: found.descriptor.id, name: found.descriptor.name,
 *     role:'guest', host: found.descriptor.host, ...found })    // the delta answer
 */

import * as chats from '../services/chats';
import { runDelta } from '../services/graph';

export function installChatDevHarness(): void {
  (window as unknown as Record<string, unknown>).__milkboxChatDev = {
    ...chats,
    runDelta,
  };
  console.info('[Dev] window.__milkboxChatDev installed');
}
