/**
 * Tab 1 Module: Secretary Interaction & Bubble Chat (`port-hub` · 互动).
 *
 * Pure zero-duplication interaction viewport featuring:
 *   1. Interactive Secretary Portrait Stage with 3 touch hotspots (头部 / 肩部 / 手部),
 *      6-stage slow affection bar (陌生 -> 熟悉 -> 信赖 -> 心动 -> 恋慕 -> 誓约),
 *      stage breakthrough mini-theatre triggers & unlocked theatre replay drawer.
 *   2. Fixed-height scrollable WeChat/QQ-style bubble chat window (`#chat-bubble-viewport`)
 *      with centered narration, left shipgirl bubbles, right commander/gift bubbles,
 *      and inline quick-reply / breakthrough choice buttons.
 *   3. Compact action bar: 日常交谈 / 赠送礼物 (Backpack Drawer) / 更换装束 (Wardrobe Drawer) / 誓约仪式.
 *   4. Bottom universal text input bound directly to `StoryEngine.dailyTalk(sec, { customTopic })`.
 *   5. Support for playing external user-imported JSON story packs when launched from Compendium Studio
 *      (all 4 legacy built-in story packs permanently purged).
 */

import { getShipClassSvg } from '../core/stat-rules.js';
import { ITEM_RARITY_MAP } from '../core/stat-rules.js';
import { getItemIconSvg } from '../core/inventory-system.js';
import { BREAKTHROUGH_THEATRES } from '../data/default-dialogues.js';
import { getActiveCharacterId, openCharacterCardById, persistCharacterRoster } from './character-console.js';

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const portState = {
  container: null,
  context: null,
  avatarCache: new Map(),
  renderedShipId: null,
  renderedMsgIds: new Set(),
  busy: false,
  unsubs: [],
};

export function resetPortHubState() {
  portState.avatarCache.clear();
  portState.renderedShipId = null;
  portState.renderedMsgIds.clear();
  portState.busy = false;
}

function getCharacters() {
  return portState.context?.entities?.list({ kind: 'character' }) || [];
}

function getActiveSecretary() {
  const { interaction, formation, rootStorage } = portState.context || {};
  const list = getCharacters();
  if (list.length === 0) return null;
  const sec = interaction?.getSecretary?.();
  if (sec && list.some((c) => c.id === sec.id)) return sec;
  const fleet = formation?.getMembers?.() || [];
  if (fleet.length > 0) return fleet[0];
  const savedId = getActiveCharacterId(rootStorage);
  return list.find((c) => c.id === savedId) || list[0];
}

async function resolveShipAvatarUrl(char) {
  if (!char || !portState.context?.assets) return '';
  const assetId = char.meta?.avatarAssetId || null;
  const key = `ship::${char.id}::${assetId || 'none'}`;
  if (portState.avatarCache.has(key)) return portState.avatarCache.get(key);
  try {
    const res = await portState.context.assets.getAssetUrl(assetId, {
      fallbackSeed: char.id,
      fallbackLabel: (char.name || '?').slice(0, 6),
    });
    portState.avatarCache.set(key, res.url);
    return res.url;
  } catch {
    return '';
  }
}

function scrollChatToBottom({ smooth = false } = {}) {
  const vp = portState.container?.querySelector('#chat-bubble-viewport');
  if (!vp) return;
  if (smooth && typeof vp.scrollTo === 'function') {
    vp.scrollTo({ top: vp.scrollHeight, behavior: 'smooth' });
  } else {
    vp.scrollTop = vp.scrollHeight;
  }
}

function buildChatMessageElement(m, avatarUrl, secName, { animate = false } = {}) {
  const wrap = document.createElement('div');
  const msgId = String(m.id || `m_${m.timestamp || Date.now()}`);
  if (m.role === 'narration') {
    wrap.className = `chat-narration${animate ? ' is-new-bubble' : ''}`;
    wrap.dataset.msgId = msgId;
    wrap.textContent = m.text || '';
    return wrap;
  }
  if (m.role === 'system') {
    wrap.className = `chat-system-pill${animate ? ' is-new-bubble' : ''}`;
    wrap.dataset.msgId = msgId;
    wrap.textContent = m.text || '';
    return wrap;
  }
  if (m.role === 'commander') {
    wrap.className = `chat-msg-row is-commander${animate ? ' is-new-bubble' : ''}`;
    wrap.dataset.msgId = msgId;
    wrap.innerHTML = `
      <div class="chat-bubble is-commander ${m.kind === 'gift' ? 'is-gift' : ''}">
        ${escapeHtml(m.text)}
      </div>
    `;
    return wrap;
  }
  wrap.className = `chat-msg-row is-ship${animate ? ' is-new-bubble' : ''}`;
  wrap.dataset.msgId = msgId;
  wrap.innerHTML = `
    <img class="chat-msg-avatar" src="${avatarUrl}" alt="${escapeHtml(m.speaker || secName)}">
    <div class="chat-bubble-col">
      <span class="chat-speaker-name">${escapeHtml(m.speaker || secName)}</span>
      <div class="chat-bubble is-ship">${escapeHtml(m.text)}</div>
    </div>
  `;
  return wrap;
}

// ============================================================
// Drawer 1: Switch Secretary
// ============================================================
function openSwitchSecretaryDrawer() {
  const { interaction, storyEngine, uiKit } = portState.context;
  const chars = getCharacters();
  const curSec = getActiveSecretary();

  uiKit.openBottomSheet({
    title: '切换执勤秘书舰',
    subtitle: '每位舰娘均拥有独立的冒泡聊天记录、6 阶好感与突破小剧场',
    renderContent: (body, close) => {
      body.innerHTML = `
        <div class="lab-stack-sm">
          ${chars
            .map((c) => {
              const st = storyEngine.getAffectionStatus(c.id);
              const isCur = curSec && c.id === curSec.id;
              return `
              <button type="button" class="lab-slot-card interact-pick-row ${isCur ? 'is-active' : ''}" data-pick-sec="${escapeHtml(c.id)}">
                <div class="interact-pick-main">
                  <span class="ship-class-ico">${getShipClassSvg(c.meta?.shipType, { size: 18 })}</span>
                  <div style="text-align:left;">
                    <strong>${escapeHtml(c.name)}</strong>
                    <div class="cc-stat-sub">${escapeHtml(c.meta?.shipType || '舰娘')} · 好感 ${st.affinity}（${escapeHtml(st.stage.label)}）</div>
                  </div>
                </div>
                <span class="status-badge ${isCur ? 'badge-ok' : 'badge-muted'}">${isCur ? '当前执勤' : '设为秘书舰'}</span>
              </button>
            `;
            })
            .join('')}
        </div>
      `;

      body.querySelectorAll('[data-pick-sec]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const cid = btn.getAttribute('data-pick-sec');
          await interaction.setSecretary(cid);
          const picked = chars.find((c) => c.id === cid);
          uiKit.showToast(`已指派「${picked?.name || '舰娘'}」担任秘书舰`, 'ok');
          close();
          renderPortHub();
        });
      });
    },
  });
}

// ============================================================
// Drawer 2: Gift Backpack Bottom Sheet
// ============================================================
function openGiftBackpackDrawer(sec) {
  const { inventory, storyEngine, entities, rootStorage, appActions, uiKit, fxStage } = portState.context;

  uiKit.openBottomSheet({
    title: `赠送心意礼物 · ${sec.name}`,
    subtitle: '仅消耗背包中已购置的礼物，稳步升温好感（+2~+5）与士气',
    renderContent: (body, close) => {
      const renderGifts = () => {
        const gifts = inventory.listBackpackGifts();
        if (gifts.length === 0) {
          body.innerHTML = `
            <div class="lab-stack-sm" style="text-align:center; padding:12px 4px;">
              <p class="muted-text" style="margin:0;">背包中暂无心意礼物，可前往「设施 → 心意礼物铺」使用银条购置！</p>
              <button type="button" id="btn-goto-gift-shop" class="btn-primary uikit-touch-target">前往心意礼物铺购置</button>
            </div>
          `;
          body.querySelector('#btn-goto-gift-shop')?.addEventListener('click', () => {
            close();
            appActions?.openFacilitiesShop?.('gifts');
          });
          return;
        }

        body.innerHTML = `
          <div class="lab-stack-sm" id="interact-gift-list">
            ${gifts
              .map((g) => {
                const rDef = ITEM_RARITY_MAP[g.rarity] || ITEM_RARITY_MAP.common;
                const affB = (g.bonuses || []).find((b) => b.stat === 'affinity')?.value ?? 3;
                const morB = (g.bonuses || []).find((b) => b.stat === 'morale')?.value ?? 10;
                return `
                <div class="lab-slot-card interact-drawer-item" data-gift-item="${escapeHtml(g.id)}">
                  <div class="interact-drawer-info">
                    <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                      <strong>${escapeHtml(g.name)}</strong>
                      <span class="status-badge rarity-badge-${escapeHtml(g.rarity || 'common')}">${escapeHtml(rDef.label)}</span>
                      <span class="status-badge badge-muted">库存 ×${Number(g.quantity || 0)}</span>
                    </div>
                    <div class="cc-stat-sub">好感 +${affB} · 士气 +${morB}</div>
                  </div>
                  <button type="button" class="btn-primary fac-mini-btn" data-send-gift="${escapeHtml(g.id)}">赠送</button>
                </div>
              `;
              })
              .join('')}
            <button type="button" id="btn-more-gifts-shop" class="btn-secondary uikit-touch-target">前往心意礼物铺补货</button>
          </div>
        `;

        body.querySelector('#btn-more-gifts-shop')?.addEventListener('click', () => {
          close();
          appActions?.openFacilitiesShop?.('gifts');
        });

        body.querySelectorAll('[data-send-gift]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const gid = btn.getAttribute('data-send-gift');
            try {
              const res = await storyEngine.giveBackpackGift(sec, gid);
              await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: sec.id });
              fxStage?.playSfx?.('success');
              uiKit.showToast(
                res.affDelta > 0
                  ? `已赠送「${res.giftName}」· 好感 +${res.affDelta} · 士气 +${res.moraleGain}`
                  : `已赠送「${res.giftName}」· 请先观看阶段突破小剧场继续升温`,
                'ok'
              );
              close();
              await renderPortHub();
            } catch (err) {
              uiKit.showToast(err instanceof Error ? err.message : '赠送失败', 'warn');
            }
          });
        });
      };
      renderGifts();
    },
  });
}

// ============================================================
// Drawer 3: Outfit / Wardrobe Bottom Sheet
// ============================================================
function openOutfitWardrobeDrawer(sec) {
  const { inventory, storyEngine, entities, rootStorage, appActions, uiKit, fxStage } = portState.context;

  uiKit.openBottomSheet({
    title: `更换装束 · ${sec.name}`,
    subtitle: '展示仓库中已解锁的全部衣装，换装后自动激活专属互动台词',
    renderContent: (body, close) => {
      const outfits = inventory.listOwnedOutfits();
      const eq = inventory.getCharacterEquipment(sec.id);
      const curOutfitId = eq?.outfit?.id || null;

      body.innerHTML = `
        <div class="lab-stack-sm" id="interact-outfit-list">
          ${
            outfits.length === 0
              ? `<p class="muted-text" style="text-align:center; margin:8px 0;">暂未拥有可穿戴装束，可前往「设施 → 衣装定制馆」选购心仪服装！</p>`
              : outfits
                  .map((it) => {
                    const isWearing = curOutfitId === it.id;
                    const wearerId = inventory.getItemWearerId?.(it.id) || null;
                    const wearer = wearerId && wearerId !== sec.id ? entities.get(wearerId) : null;
                    const rDef = ITEM_RARITY_MAP[it.rarity] || ITEM_RARITY_MAP.common;
                    return `
                    <div class="lab-slot-card interact-drawer-item ${isWearing ? 'is-active' : ''}" data-outfit-item="${escapeHtml(it.id)}">
                      <div class="interact-drawer-info">
                        <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                          <span>${getItemIconSvg(it, { size: 16 })}</span>
                          <strong>${escapeHtml(it.name)}</strong>
                          <span class="status-badge rarity-badge-${escapeHtml(it.rarity || 'common')}">${escapeHtml(rDef.label)}</span>
                        </div>
                        <div class="cc-stat-sub">
                          ${escapeHtml(it.outfitStyle || '港区装束')}${wearer ? ` · 当前由「${escapeHtml(wearer.name)}」穿戴` : ''}
                        </div>
                      </div>
                      ${
                        isWearing
                          ? `<button type="button" class="btn-secondary fac-mini-btn" data-unequip-outfit="true">卸下</button>`
                          : `<button type="button" class="btn-primary fac-mini-btn" data-equip-outfit="${escapeHtml(it.id)}">换上</button>`
                      }
                    </div>
                  `;
                  })
                  .join('')
          }
          <button type="button" id="btn-goto-outfit-shop" class="btn-secondary uikit-touch-target">前往衣装定制馆选购新衣</button>
        </div>
      `;

      body.querySelector('#btn-goto-outfit-shop')?.addEventListener('click', () => {
        close();
        appActions?.openFacilitiesShop?.('outfits');
      });

      body.querySelectorAll('[data-equip-outfit]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const oid = btn.getAttribute('data-equip-outfit');
          try {
            await inventory.equipItem(sec.id, 'outfit', oid);
            await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: sec.id });
            const item = inventory.getItem(oid);
            fxStage?.playSfx?.('success');
            uiKit.showToast(`「${sec.name}」已换上「${item?.name || '新装束'}」！`, 'ok');
            close();
            await renderPortHub();
          } catch (err) {
            uiKit.showToast(err instanceof Error ? err.message : '换装失败', 'warn');
          }
        });
      });

      body.querySelector('[data-unequip-outfit]')?.addEventListener('click', async () => {
        try {
          await inventory.unequipSlot(sec.id, 'outfit');
          await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: sec.id });
          uiKit.showToast(`「${sec.name}」已换回日常港区便装`, 'info');
          close();
          await renderPortHub();
        } catch (err) {
          uiKit.showToast(err instanceof Error ? err.message : '卸下失败', 'warn');
        }
      });
    },
  });
}

// ============================================================
// Drawer 4: Replay Unlocked Breakthrough Theatres
// ============================================================
function openBreakthroughReplayDrawer(sec, status) {
  const { storyEngine, uiKit } = portState.context;
  uiKit.openBottomSheet({
    title: `阶段突破小剧场回顾 · ${sec.name}`,
    subtitle: '历史存档已跨过的好感阶段也会自动解锁，随时可在聊天窗重温',
    renderContent: (body, close) => {
      const gates = status.unlockedGates || [];
      body.innerHTML = `
        <div class="lab-stack-sm">
          ${gates
            .map((gate) => {
              const t = BREAKTHROUGH_THEATRES[gate];
              if (!t) return '';
              return `
              <div class="lab-slot-card interact-drawer-item">
                <div class="interact-drawer-info">
                  <strong>${escapeHtml(t.title)}</strong>
                  <div class="cc-stat-sub">好感 ${gate} 节点 · ${escapeHtml(t.fromLabel)} → ${escapeHtml(t.toLabel)}</div>
                </div>
                <button type="button" class="btn-secondary fac-mini-btn" data-replay-gate="${gate}">重温</button>
              </div>
            `;
            })
            .join('')}
        </div>
      `;
      body.querySelectorAll('[data-replay-gate]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const gate = Number(btn.getAttribute('data-replay-gate'));
          await storyEngine.startBreakthroughTheatre(sec, gate, { isReplay: true });
          close();
          await renderPortHub();
        });
      });
    },
  });
}

// ============================================================
// Optional External Imported Story Pack Player (Zero Legacy Built-ins)
// ============================================================
function renderExternalStorySessionCard() {
  const { storyPacks, uiKit } = portState.context;
  const sess = storyPacks?.getActiveTheatreSession?.();
  if (!sess || !sess.pack || sess.pack.builtIn) return null;

  const node = sess.node;
  const card = document.createElement('section');
  card.className = 'surface-card lab-stack-sm interact-ext-story-card';
  card.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <strong>📖 外置剧情 · ${escapeHtml(sess.pack.title || '外置扩展包')}</strong>
      <button type="button" id="btn-ext-story-exit" class="btn-secondary fac-mini-btn">收起</button>
    </div>
    <p style="font-size:13px; line-height:1.65; margin:0;">${escapeHtml(node?.text || node?.body || '剧情节点已完成。')}</p>
    <div class="lab-stack-sm">
      ${(node?.choices || [])
        .map(
          (ch, idx) =>
            `<button type="button" class="btn-secondary uikit-touch-target" data-ext-choice="${idx}">${escapeHtml(ch.label || `选项 ${idx + 1}`)}</button>`
        )
        .join('')}
    </div>
  `;

  card.querySelector('#btn-ext-story-exit')?.addEventListener('click', () => {
    storyPacks.clearActiveTheatreSession();
    renderPortHub();
  });
  card.querySelectorAll('[data-ext-choice]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = Number(btn.getAttribute('data-ext-choice'));
      try {
        await storyPacks.chooseOption(sess.pack.id, node?.id, idx);
        renderPortHub();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : '剧情推进失败', 'warn');
      }
    });
  });

  return card;
}

function bindQuickReplyChoices(containerEl, sec) {
  const { storyEngine, entities, rootStorage, uiKit, fxStage } = portState.context;
  containerEl.querySelectorAll('[data-chat-choice]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (portState.busy) return;
      portState.busy = true;
      try {
        const cid = btn.getAttribute('data-chat-choice');
        const res = await storyEngine.resolveChatChoice(sec, cid);
        await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: sec.id });
        if (res?.unlockedGate) {
          fxStage?.playSfx?.('success');
          uiKit.showToast(`🎉 已突破 ${res.unlockedGate} 羁绊阶段！`, 'ok');
        }
        await renderPortHub();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : '回复失败', 'warn');
      } finally {
        portState.busy = false;
      }
    });
  });
}

function renderHeroStageActionsMarkup(status) {
  return `
    ${
      status.pendingGate
        ? `<button type="button" id="btn-sec-breakthrough" class="btn-primary interact-breakthrough-btn">✨ ${status.pendingGate} 阶段突破小剧场</button>`
        : ''
    }
    ${
      status.unlockedGates.length > 0
        ? `<button type="button" id="btn-sec-replay" class="btn-secondary interact-mini-chip">↺ 剧场回顾 (${status.unlockedGates.length})</button>`
        : ''
    }
    ${
      status.affinity >= 100 && !status.isOathed
        ? `<button type="button" id="btn-sec-oath" class="btn-primary interact-mini-chip">💍 誓约仪式</button>`
        : ''
    }
  `;
}

function bindHeroStageActions(rootEl, sec, status) {
  const { storyEngine, interaction, entities, rootStorage, uiKit, fxStage } = portState.context;
  rootEl.querySelector('#btn-sec-breakthrough')?.addEventListener('click', async () => {
    if (!status.pendingGate) return;
    await storyEngine.startBreakthroughTheatre(sec, status.pendingGate, { isReplay: false });
    await renderPortHub();
  });
  rootEl.querySelector('#btn-sec-replay')?.addEventListener('click', () => {
    openBreakthroughReplayDrawer(sec, status);
  });
  rootEl.querySelector('#btn-sec-oath')?.addEventListener('click', async () => {
    try {
      await interaction.performOathCeremony(sec.id);
      storyEngine.syncLegacyBreakthroughs();
      await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: sec.id });
      fxStage?.playSfx?.('success');
      uiKit.showToast(`💍 已与「${sec.name}」缔结誓约，好感上限提升至 200！`, 'ok');
      await renderPortHub();
    } catch (err) {
      uiKit.showToast(err instanceof Error ? err.message : '誓约仪式条件不足', 'warn');
    }
  });
}

function renderQuickRepliesSlot(slotEl, sec, activePrompt) {
  if (!slotEl) return;
  if (activePrompt && Array.isArray(activePrompt.choices) && activePrompt.choices.length > 0) {
    slotEl.hidden = false;
    slotEl.innerHTML = `
      <div class="chat-quick-replies" id="chat-quick-replies" data-no-swipe="true">
        ${activePrompt.choices
          .map(
            (ch) =>
              `<button type="button" class="chat-choice-btn" data-chat-choice="${escapeHtml(ch.id)}">${escapeHtml(ch.label)}</button>`
          )
          .join('')}
      </div>
    `;
    bindQuickReplyChoices(slotEl, sec);
  } else {
    slotEl.hidden = true;
    slotEl.innerHTML = '';
  }
}

// ============================================================
// Main Tab 1 Render (Zero-Jump Incremental Append when Same Ship)
// ============================================================
async function renderPortHub({ forceFull = false } = {}) {
  if (!portState.container || !portState.context) return;
  const { storyEngine, inventory, storyPacks, entities, rootStorage, uiKit, fxStage } = portState.context;
  const sec = getActiveSecretary();

  if (!sec) {
    portState.renderedShipId = null;
    portState.renderedMsgIds.clear();
    portState.container.innerHTML = `
      <div class="interact-hub-root" id="page-port-hub">
        <div class="surface-card" style="text-align:center; padding:24px;">
          <p class="muted-text">当前港区尚无执勤舰娘，请前往「设施 → 舰船建造」建造新舰！</p>
        </div>
      </div>
    `;
    return;
  }

  storyEngine.ensureGreeting(sec);
  const avatarUrl = await resolveShipAvatarUrl(sec);
  const status = storyEngine.getAffectionStatus(sec.id);
  const eq = inventory.getCharacterEquipment(sec.id);
  const outfitName = eq?.outfit?.name || '日常港区便装';
  const history = storyEngine.getChatHistory(sec.id);
  const activePrompt = storyEngine.getActivePrompt(sec.id);
  const affPct = Math.min(100, Math.round((status.affinity / Math.max(1, status.maxAffinity)) * 100));
  const activeExtSess = storyPacks?.getActiveTheatreSession?.();
  const hasExtSession = Boolean(activeExtSess && activeExtSess.pack && !activeExtSess.pack.builtIn);

  // FAST INCREMENTAL PATH: Same secretary already mounted -> NEVER rebuild viewport or reset scrollTop to 0!
  const existingViewport = portState.container.querySelector('#chat-bubble-viewport');
  const existingExtCard = portState.container.querySelector('.interact-ext-story-card');
  if (
    !forceFull &&
    existingViewport &&
    portState.renderedShipId === sec.id &&
    !hasExtSession &&
    !existingExtCard
  ) {
    // 1. Update hero badges & affection bar in-place
    const stageBadge = portState.container.querySelector('#sec-aff-stage-badge');
    if (stageBadge) stageBadge.textContent = `${status.stage.label}${status.isOathed ? ' 💍' : ''}`;
    const outfitEl = portState.container.querySelector('#sec-outfit-label');
    if (outfitEl) outfitEl.textContent = `着装：${outfitName}`;
    const affValEl = portState.container.querySelector('#sec-aff-val');
    if (affValEl) affValEl.textContent = String(status.affinity);
    const affMaxEl = portState.container.querySelector('#sec-aff-max');
    if (affMaxEl) affMaxEl.textContent = String(status.maxAffinity);
    const dailyEl = portState.container.querySelector('#sec-daily-talk');
    if (dailyEl) dailyEl.textContent = `今日闲聊 ${status.dailyTalkUsed}/${status.dailyTalkCap}`;
    const affFill = portState.container.querySelector('#sec-aff-fill');
    if (affFill) affFill.style.width = `${affPct}%`;
    const actionsRow = portState.container.querySelector('#interact-stage-actions');
    if (actionsRow) {
      actionsRow.innerHTML = renderHeroStageActionsMarkup(status);
      bindHeroStageActions(actionsRow, sec, status);
    }

    // 2. Append ONLY newly arrived bubbles directly to the bottom of #chat-bubble-viewport!
    let appended = 0;
    for (const m of history) {
      const mid = String(m.id || `m_${m.timestamp || ''}`);
      if (portState.renderedMsgIds.has(mid)) continue;
      const el = buildChatMessageElement(m, avatarUrl, sec.name, { animate: true });
      existingViewport.appendChild(el);
      portState.renderedMsgIds.add(mid);
      appended += 1;
    }

    // 3. Update quick replies in-place
    const repliesSlot = portState.container.querySelector('#chat-quick-replies-slot');
    renderQuickRepliesSlot(repliesSlot, sec, activePrompt);

    // 4. Smooth-scroll ONLY from current bottom position to newly appended bottom (NEVER jumping to 0!)
    if (appended > 0 || activePrompt) {
      scrollChatToBottom({ smooth: true });
    }
    return;
  }

  // FULL MOUNT / SECRETARY SWITCH PATH
  portState.container.innerHTML = '';
  portState.renderedShipId = sec.id;
  portState.renderedMsgIds.clear();

  const root = document.createElement('div');
  root.className = 'interact-hub-root';
  root.id = 'page-port-hub';

  // Optional external imported story pack player
  const extCard = renderExternalStorySessionCard();
  if (extCard) root.appendChild(extCard);

  // 1. Compact Portrait + Touch Zone + 6-Stage Affection Card
  const heroCard = document.createElement('section');
  heroCard.className = 'surface-card interact-hero-card';
  heroCard.id = 'interact-hero-card';
  heroCard.innerHTML = `
    <div class="interact-hero-top">
      <div class="interact-portrait-wrap" id="interact-portrait-stage">
        <img id="sec-portrait-img" class="interact-portrait-img" src="${avatarUrl}" alt="${escapeHtml(sec.name)}">
        <button type="button" class="touch-hotspot is-head" data-touch-zone="head" title="轻抚发顶" aria-label="轻抚发顶">发顶</button>
        <button type="button" class="touch-hotspot is-shoulder" data-touch-zone="shoulder" title="轻触肩头" aria-label="轻触肩头">肩头</button>
        <button type="button" class="touch-hotspot is-hand" data-touch-zone="hand" title="轻握指尖" aria-label="轻握指尖">指尖</button>
      </div>

      <div class="interact-meta-col">
        <div class="interact-name-row">
          <div style="display:flex; align-items:center; gap:6px; min-width:0;">
            <span class="ship-class-ico">${getShipClassSvg(sec.meta?.shipType, { size: 17 })}</span>
            <strong class="interact-ship-name" id="sec-name-label">${escapeHtml(sec.name)}</strong>
            <span class="status-badge badge-muted">Lv.${sec.stats?.level || 1}</span>
          </div>
          <div style="display:flex; gap:4px; flex-shrink:0;">
            <button type="button" id="btn-sec-profile" class="interact-icon-btn" title="查看舰娘档案">档案</button>
            <button type="button" id="btn-sec-switch" class="interact-icon-btn" title="更换秘书舰">切换</button>
          </div>
        </div>

        <div class="interact-outfit-line">
          <span class="status-badge interact-stage-pill" id="sec-aff-stage-badge">${escapeHtml(status.stage.label)}${status.isOathed ? ' 💍' : ''}</span>
          <span class="muted-text interact-outfit-name" id="sec-outfit-label">着装：${escapeHtml(outfitName)}</span>
        </div>

        <div class="interact-aff-box">
          <div class="interact-aff-head">
            <span>好感 <strong id="sec-aff-val">${status.affinity}</strong>/<span id="sec-aff-max">${status.maxAffinity}</span></span>
            <span class="muted-text" id="sec-daily-talk">今日闲聊 ${status.dailyTalkUsed}/${status.dailyTalkCap}</span>
          </div>
          <div class="interact-aff-track">
            <div class="interact-aff-fill" id="sec-aff-fill" style="width:${affPct}%"></div>
          </div>
        </div>

        <div class="interact-stage-actions" id="interact-stage-actions">
          ${renderHeroStageActionsMarkup(status)}
        </div>
      </div>
    </div>
  `;

  heroCard.querySelectorAll('[data-touch-zone]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (portState.busy) return;
      portState.busy = true;
      try {
        const zone = btn.getAttribute('data-touch-zone');
        await storyEngine.touchPortrait(sec, zone);
        await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: sec.id });
        fxStage?.playSfx?.('click');
        await renderPortHub();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : '互动响应失败', 'warn');
      } finally {
        portState.busy = false;
      }
    });
  });

  heroCard.querySelector('#btn-sec-profile')?.addEventListener('click', () => {
    openCharacterCardById(sec.id, portState.context);
  });
  heroCard.querySelector('#btn-sec-switch')?.addEventListener('click', () => openSwitchSecretaryDrawer());
  bindHeroStageActions(heroCard, sec, status);
  root.appendChild(heroCard);

  // 2. Scrollable WeChat/QQ-Style Bubble Chat Window
  const chatShell = document.createElement('section');
  chatShell.className = 'surface-card interact-chat-shell';
  chatShell.innerHTML = `
    <div class="chat-bubble-viewport" id="chat-bubble-viewport"></div>
    <div id="chat-quick-replies-slot" hidden></div>
    <div class="interact-action-bar" id="interact-action-bar">
      <button type="button" id="btn-sec-talk" class="btn-primary interact-act-btn">日常交谈</button>
      <button type="button" id="btn-sec-gift" class="btn-secondary interact-act-btn">赠送礼物</button>
      <button type="button" id="btn-sec-outfit" class="btn-secondary interact-act-btn">更换装束</button>
    </div>
  `;

  const vp = chatShell.querySelector('#chat-bubble-viewport');
  for (const m of history) {
    const mid = String(m.id || `m_${m.timestamp || ''}`);
    vp.appendChild(buildChatMessageElement(m, avatarUrl, sec.name, { animate: false }));
    portState.renderedMsgIds.add(mid);
  }
  renderQuickRepliesSlot(chatShell.querySelector('#chat-quick-replies-slot'), sec, activePrompt);

  chatShell.querySelector('#btn-sec-talk')?.addEventListener('click', async () => {
    if (portState.busy) return;
    portState.busy = true;
    try {
      const res = await storyEngine.dailyTalk(sec);
      await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: sec.id });
      fxStage?.playSfx?.('click');
      if (res.affDelta > 0) {
        uiKit.showToast(`${sec.name} 好感 +${res.affDelta}（当前 ${res.afterAff}）`, 'ok');
      } else if (res.pendingGate) {
        uiKit.showToast(`请先点击上方「✨ ${res.pendingGate} 阶段突破小剧场」继续升温！`, 'info');
      }
      await renderPortHub();
    } catch (err) {
      uiKit.showToast(err instanceof Error ? err.message : '交谈出现异常，已自动保护', 'warn');
    } finally {
      portState.busy = false;
    }
  });

  chatShell.querySelector('#btn-sec-gift')?.addEventListener('click', () => {
    openGiftBackpackDrawer(sec);
  });

  chatShell.querySelector('#btn-sec-outfit')?.addEventListener('click', () => {
    openOutfitWardrobeDrawer(sec);
  });

  root.appendChild(chatShell);
  portState.container.appendChild(root);

  // Instant snap to bottom on initial mount/secretary switch (zero top-to-bottom jump)
  scrollChatToBottom({ smooth: false });
}

export default {
  id: 'port-hub',
  name: '互动',
  description: '秘书舰触碰互动、6 阶慢节奏好感、阶段突破小剧场与滚动气泡聊天窗。',
  mount(container, context) {
    portState.container = container;
    portState.context = context;
    portState.avatarCache.clear();
    portState.renderedShipId = null;
    portState.renderedMsgIds.clear();
    context.ui.setSwipeLocked(false);
    context.ui.setPlaceholder('和秘书舰聊聊今天想说的话...');
    context.ui.setInputHandler(async (text) => {
      const sec = getActiveSecretary();
      if (!sec) {
        context.ui.showToast('当前港区尚无执勤舰娘', 'warn');
        return;
      }
      context.ui.setInputBusy(true);
      try {
        await context.storyEngine.dailyTalk(sec, { customTopic: text });
        await persistCharacterRoster({
          storage: context.rootStorage,
          entities: context.entities,
          activeCharacterId: sec.id,
        });
        await renderPortHub();
      } catch (err) {
        context.ui.showToast(err instanceof Error ? err.message : '发送消息失败', 'warn');
      } finally {
        context.ui.setInputBusy(false);
      }
    });

    portState.unsubs = [
      context.bus.on('inventory:equipped', () => renderPortHub()),
      context.bus.on('inventory:unequipped', () => renderPortHub()),
      context.bus.on('interaction:oathed', () => renderPortHub()),
      context.bus.on('story:packs-changed', () => renderPortHub({ forceFull: true })),
    ];

    renderPortHub({ forceFull: true });
  },
  unmount() {
    portState.unsubs.forEach((u) => { try { u(); } catch {} });
    portState.unsubs = [];
    portState.renderedShipId = null;
    portState.renderedMsgIds.clear();
    portState.container = null;
    portState.context = null;
  },
};
