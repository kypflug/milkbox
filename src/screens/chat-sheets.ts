/**
 * Shared-chat overlays: create, consent interstitial, invite (QR + link),
 * manage members, and join progress. Portaled to document.body (the pane
 * layout clips overflow, and fixed children of body escape it — the same
 * trick the lightbox uses).
 */

import QRCode from 'qrcode';
import { escapeAttr, escapeHtml } from '../utils/storage';
import { showToast } from '../components/toast';
import { iconClose } from '../components/icons';
import * as coordinator from '../services/sync-coordinator';
import { encodeShareUrl } from '../services/chats';
import { GraphHttpError } from '../services/graph';

export interface ModalHandle {
  el: HTMLElement;
  body: HTMLElement;
  close(): void;
}

/** The house sheet: portaled to body, scrim, Escape/backdrop/close-button
 *  dismissal. Also the shell for the chat switcher dialog. */
export function openModal(title: string, bodyHtml: string, opts: { onClose?: () => void } = {}): ModalHandle {
  const scrim = document.createElement('div');
  scrim.className = 'chat-modal-scrim';
  scrim.innerHTML = `
    <div class="chat-modal" role="dialog" aria-modal="true" aria-label="${escapeAttr(title)}">
      <header class="chat-modal-header">
        <h2 class="chat-modal-title">${escapeHtml(title)}</h2>
        <button class="chat-modal-close" aria-label="Close">${iconClose('1.1em')}</button>
      </header>
      <div class="chat-modal-body">${bodyHtml}</div>
    </div>
  `;
  const close = () => {
    document.removeEventListener('keydown', onKey);
    scrim.remove();
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  scrim.addEventListener('click', e => {
    if (e.target === scrim || (e.target as HTMLElement).closest('.chat-modal-close')) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(scrim);
  const body = scrim.querySelector<HTMLElement>('.chat-modal-body')!;
  return { el: scrim, body, close };
}

// ─── create ───

export function showCreateChatSheet(onSubmit: (name: string) => void): void {
  const modal = openModal('New chat', `
    <label class="chat-field-label" for="chatNameInput">Chat name</label>
    <input class="chat-field-input" id="chatNameInput" type="text" maxlength="64"
           placeholder="Chat name" autocomplete="off">
    <p class="chat-modal-hint">A shared chat lives in a folder in your OneDrive. Everyone you
    invite can read and add drops there.</p>
    <div class="chat-modal-actions">
      <button class="chat-modal-primary" data-action="create">Create chat</button>
    </div>
  `);
  const input = modal.body.querySelector<HTMLInputElement>('#chatNameInput')!;
  input.focus();
  const submit = () => {
    const name = input.value.trim();
    if (!name) {
      input.focus();
      return;
    }
    modal.close();
    onSubmit(name);
  };
  modal.body.querySelector('[data-action="create"]')!.addEventListener('click', submit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') submit();
  });
}

// ─── consent interstitial ───

export function showConsentInterstitial(onContinue: () => void): void {
  const modal = openModal('Let Milkbox open shared folders', `
    <p class="chat-modal-text">Shared chats live in a folder in the host's OneDrive. To read and
    write there, Milkbox needs broader OneDrive permission than your private milkbox uses.</p>
    <p class="chat-modal-text">Microsoft will ask you to approve <strong>“Have full access to your
    files.”</strong> Milkbox still only ever touches Milkbox folders.</p>
    <div class="chat-modal-actions">
      <button class="chat-modal-secondary" data-action="cancel">Not now</button>
      <button class="chat-modal-primary" data-action="continue">Continue with Microsoft</button>
    </div>
  `);
  modal.body.querySelector('[data-action="cancel"]')!.addEventListener('click', () => modal.close());
  modal.body.querySelector('[data-action="continue"]')!.addEventListener('click', () => {
    modal.close();
    onContinue();
  });
}

// ─── rename ───

export function showRenameChatSheet(chat: { id: string; name: string }): void {
  const modal = openModal('Rename chat', `
    <label class="chat-field-label" for="chatRenameInput">Chat name</label>
    <input class="chat-field-input" id="chatRenameInput" type="text" maxlength="${coordinator.MAX_CHAT_NAME}"
           value="${escapeAttr(chat.name)}" autocomplete="off">
    <p class="chat-modal-hint">Everyone in the chat sees the new name on their next sync.</p>
    <div class="chat-modal-actions">
      <button class="chat-modal-primary" data-action="rename">Rename</button>
    </div>
  `);
  const input = modal.body.querySelector<HTMLInputElement>('#chatRenameInput')!;
  const button = modal.body.querySelector<HTMLButtonElement>('[data-action="rename"]')!;
  input.focus();
  input.select();
  const submit = async () => {
    const name = input.value.trim();
    if (!name) {
      input.focus();
      return;
    }
    if (name === chat.name) {
      modal.close();
      return;
    }
    button.disabled = true;
    input.disabled = true;
    try {
      await coordinator.renameChat(chat.id, name);
      modal.close();
      showToast(`Renamed to ${name}`);
    } catch (err) {
      console.warn('[Chats] Rename failed:', err);
      button.disabled = false;
      input.disabled = false;
      showToast('Couldn’t rename the chat. Try again.', 'error');
    }
  };
  button.addEventListener('click', () => void submit());
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') void submit();
  });
}

// ─── invite ───

export async function showInviteSheet(chatId: string): Promise<void> {
  const chats = await coordinator.loadChats();
  const chat = chats.find(c => c.id === chatId);
  if (!chat) return;

  const modal = openModal(`Invite to ${chat.name}`, `
    <div class="chat-invite-qr"><canvas class="chat-invite-canvas" width="220" height="220"></canvas></div>
    <div class="chat-invite-link-row">
      <input class="chat-field-input chat-invite-link" type="text" readonly aria-label="Invite link">
      <button class="chat-modal-primary" data-action="copy">Copy link</button>
    </div>
    <p class="chat-modal-hint">Anyone with this link can join and read everything in this chat.
    They'll sign in with their own Microsoft account.</p>
    <div class="chat-modal-actions">
      <button class="chat-modal-secondary" data-action="reset">Reset link</button>
    </div>
  `);

  const canvas = modal.body.querySelector<HTMLCanvasElement>('.chat-invite-canvas')!;
  const linkInput = modal.body.querySelector<HTMLInputElement>('.chat-invite-link')!;

  async function render(shareUrl: string): Promise<void> {
    const deepLink = `${location.origin}/#join=${encodeShareUrl(shareUrl)}`;
    linkInput.value = deepLink;
    try {
      await QRCode.toCanvas(canvas, deepLink, { width: 220, margin: 1 });
    } catch (err) {
      console.warn('[Chats] QR render failed:', err);
    }
  }

  try {
    await render(await coordinator.ensureInviteLink(chatId));
  } catch (err) {
    modal.close();
    console.warn('[Chats] Invite link failed:', err);
    showToast(
      err instanceof GraphHttpError
        ? `Couldn’t create the invite link — OneDrive error ${err.status}. Try again.`
        : 'Couldn’t create the invite link. Check your connection and try again.',
      'error',
    );
    return;
  }

  modal.body.querySelector('[data-action="copy"]')!.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(linkInput.value);
      showToast('Invite link copied');
    } catch {
      linkInput.select();
      showToast('Copy failed — the link is selected, copy it manually', 'error');
    }
  });

  modal.body.querySelector('[data-action="reset"]')!.addEventListener('click', async () => {
    const sure = confirm(
      'Reset the invite link? New people won’t be able to use the old link, and members who joined with it may need the new one to keep access.',
    );
    if (!sure) return;
    try {
      await render(await coordinator.rotateInviteLink(chatId));
      showToast('Invite link reset');
    } catch (err) {
      console.warn('[Chats] Link reset failed:', err);
      showToast('Couldn’t reset the link. Try again.', 'error');
    }
  });
}

// ─── manage ───

export async function showManageSheet(
  chatId: string,
  opts: { onGoneFromList?: () => void } = {},
): Promise<void> {
  const chats = await coordinator.loadChats();
  const chat = chats.find(c => c.id === chatId);
  if (!chat) return;
  const isHost = chat.role === 'host';
  const members = (await coordinator.getCachedMembers(`chat:${chatId}`)) ?? [];

  const memberRows = members.map(member => `
    <div class="chat-member-row">
      <span class="chat-member-name">${escapeHtml(member.name)}${member.id === chat.host.id ? ' <span class="chat-member-tag">host</span>' : ''}</span>
      ${isHost && member.id !== chat.host.id
        ? `<button class="chat-member-remove" data-remove="${escapeAttr(member.id)}" data-name="${escapeAttr(member.name)}">Remove</button>`
        : ''}
    </div>`).join('');

  const modal = openModal(chat.name, `
    <p class="chat-modal-hint">${isHost
      ? 'You host this chat — it lives in your OneDrive, and drops from everyone count against your storage.'
      : `Hosted by ${escapeHtml(chat.host.name)}. The chat lives in their OneDrive.`}</p>
    <div class="chat-member-list">
      ${memberRows || '<p class="chat-modal-hint">No members yet — share the invite link.</p>'}
    </div>
    <div class="chat-modal-actions chat-modal-actions--column">
      ${isHost ? `
        <button class="chat-modal-secondary" data-action="invite">Show invite link</button>
        <button class="chat-modal-secondary" data-action="rename">Rename chat</button>
        <button class="chat-modal-danger" data-action="delete">Delete chat for everyone</button>
      ` : `
        <button class="chat-modal-danger" data-action="leave">Leave chat</button>
      `}
    </div>
  `);

  modal.body.addEventListener('click', async e => {
    const removeBtn = (e.target as HTMLElement).closest<HTMLElement>('[data-remove]');
    if (removeBtn) {
      const memberId = removeBtn.dataset.remove!;
      const memberName = removeBtn.dataset.name || 'this member';
      if (!confirm(`Remove ${memberName}? They lose access, but keep anything they already downloaded.`)) return;
      try {
        await coordinator.removeMember(chatId, memberId);
        showToast(`${memberName} removed`);
        removeBtn.closest('.chat-member-row')?.remove();
      } catch (err) {
        if (err instanceof Error && err.message === 'unsupported') {
          showToast('OneDrive can’t remove one person from this link — reset the invite link instead.', 'error');
        } else {
          console.warn('[Chats] Remove member failed:', err);
          showToast('Couldn’t remove them. Try again.', 'error');
        }
      }
      return;
    }
    const actionEl = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action!;
    if (action === 'invite') {
      modal.close();
      void showInviteSheet(chatId);
    } else if (action === 'rename') {
      modal.close();
      showRenameChatSheet(chat);
    } else if (action === 'delete') {
      if (!confirm(`Delete ${chat.name} for everyone? All drops and files in this chat will be permanently deleted from your OneDrive.`)) return;
      modal.close();
      try {
        await coordinator.deleteChatHosted(chatId);
        showToast('Chat deleted');
        opts.onGoneFromList?.();
      } catch (err) {
        console.warn('[Chats] Delete failed:', err);
        showToast('Couldn’t delete the chat. Try again.', 'error');
      }
    } else if (action === 'leave') {
      if (!confirm(`Leave ${chat.name}? You'll stop seeing it on your devices. To fully remove your access, ask the host to remove you.`)) return;
      modal.close();
      await coordinator.leaveChat(chatId);
      showToast(`You left ${chat.name}`);
      opts.onGoneFromList?.();
    }
  });
}

// ─── join progress ───

export interface JoinProgressHandle {
  fail(title: string, message: string, retry?: () => void): void;
  close(): void;
}

export function showJoinProgress(): JoinProgressHandle {
  const modal = openModal('Joining chat…', `
    <div class="chat-join-progress"><span class="spinner" aria-hidden="true"></span>
    <p class="chat-modal-text">Connecting to the chat folder…</p></div>
  `);
  return {
    fail(title: string, message: string, retry?: () => void) {
      modal.body.innerHTML = `
        <p class="chat-modal-text"><strong>${escapeHtml(title)}</strong></p>
        <p class="chat-modal-text">${escapeHtml(message)}</p>
        <div class="chat-modal-actions">
          ${retry ? '<button class="chat-modal-primary" data-action="retry">Try again</button>' : ''}
          <button class="chat-modal-secondary" data-action="back">Back to my milkbox</button>
        </div>
      `;
      modal.body.querySelector('[data-action="back"]')?.addEventListener('click', () => modal.close());
      if (retry) {
        modal.body.querySelector('[data-action="retry"]')?.addEventListener('click', () => {
          modal.close();
          retry();
        });
      }
    },
    close: modal.close,
  };
}
