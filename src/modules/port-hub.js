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

        const favIds = typeof storyEngine.getFavoriteGiftIds === 'function' ? storyEngine.getFavoriteGiftIds(sec) : [];
        const isFavGift = (g) => favIds.includes(g.id) || favIds.some((fid) => g.id && String(g.id).includes(fid));
        const sortedGifts = [...gifts].sort((a, b) => Number(isFavGift(b)) - Number(isFavGift(a)));

        body.innerHTML = `
          <div class="lab-stack-sm" id="interact-gift-list">
            ${sortedGifts
              .map((g) => {
                const rDef = ITEM_RARITY_MAP[g.rarity] || ITEM_RARITY_MAP.common;
                const affB = (g.bonuses || []).find((b) => b.stat === 'affinity')?.value ?? 3;
                const morB = (g.bonuses || []).find((b) => b.stat === 'morale')?.value ?? 10;
                const fav = isFavGift(g);
                return `
                <div class="lab-slot-card interact-drawer-item ${fav ? 'is-active' : ''}" data-gift-item="${escapeHtml(g.id)}" data-is-favorite="${fav ? 'true' : 'false'}" style="${fav ? 'border-color:rgba(244,114,182,0.55); background:rgba(244,114,182,0.08);' : ''}">
                  <div class="interact-drawer-info">
                    <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                      <strong>${escapeHtml(g.name)}</strong>
                      ${fav ? '<span class="status-badge badge-warn" data-fav-badge="true">💖 偏爱</span>' : ''}
                      <span class="status-badge rarity-badge-${escapeHtml(g.rarity || 'common')}">${escapeHtml(rDef.label)}</span>
                      <span class="status-badge badge-muted">库存 ×${Number(g.quantity || 0)}</span>
                    </div>
                    <div class="cc-stat-sub">
                      好感 +${fav ? `${affB}+2(偏爱)` : affB} · 士气 +${fav ? morB + 6 : morB}
                    </div>
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
                  ? `${res.isFavorite ? '💖 偏爱礼物惊喜反应！' : ''}已赠送「${res.giftName}」· 好感 +${res.affDelta} · 士气 +${res.moraleGain}`
                  : `${res.isFavorite ? '💖 偏爱礼物！' : ''}已赠送「${res.giftName}」· 请先观看阶段突破小剧场继续升温`,
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
// Drawer 4: Memoirs Drawer (回忆录：突破小剧场回放 + 誓约仪式回放 + 特殊衣装展示)
// ============================================================
function openMemoirsDrawer(sec, status = null) {
  const { storyEngine, storyPacks, personalityPool, inventory, entities, rootStorage, uiKit, fxStage } = portState.context;
  const liveStatus = storyEngine?.getAffectionStatus ? storyEngine.getAffectionStatus(sec.id) : status || { unlockedGates: [], isOathed: false };
  const actorPrimaryId =
    sec?.meta?.personalityCombo?.primaryId ||
    storyEngine?._resolveActorPrimaryId?.(sec) ||
    null;

  const playablePacks = (storyPacks?.listPacks?.({ enabledOnly: true }) || [])
    .filter((p) => !p.builtIn && p.category !== 'sortie_encounter')
    .sort((a, b) => {
      const rank = (p) => {
        if (actorPrimaryId && p.personalityId === actorPrimaryId) return 0;
        if (!p.personalityId) return 1;
        return 2;
      };
      return rank(a) - rank(b);
    });

  const getPersonalityName = (pid) => {
    if (!pid) return '';
    return personalityPool?.getPrimaryByIdOrName?.(pid)?.name || pid;
  };

  uiKit.openBottomSheet({
    title: `📖 专属回忆录 · ${sec.name}`,
    subtitle: '汇集已解锁的六阶段突破小剧场、誓约仪式、专属深夜长剧场与特殊衣装展示',
    renderContent: (body, close) => {
      const gates = liveStatus.unlockedGates || [];
      const isOathed = Boolean(liveStatus.isOathed);
      const outfits = inventory?.listOwnedOutfits ? inventory.listOwnedOutfits() : [];
      const eq = inventory?.getCharacterEquipment ? inventory.getCharacterEquipment(sec.id) : {};
      const curOutfitId = eq?.outfit?.id || null;

      body.innerHTML = `
        <div class="module-stack" id="memoirs-drawer-body">
          <!-- Section 0: Personal Late-Night & External Story Packs -->
          <div class="surface-card lab-stack-sm" style="padding:10px 12px; border-color:rgba(244,114,182,0.45);">
            <div class="section-header-row" style="margin-bottom:0;">
              <strong style="font-size:13px;">🌙 专属深夜剧场与外置剧本（${playablePacks.length} 篇）</strong>
              <span class="status-badge badge-ok">一键直达</span>
            </div>
            ${
              playablePacks.length === 0
                ? '<p class="muted-text" style="font-size:12px; margin:0;">暂无已启用的港区剧场包，可在顶栏「自定义工坊 → 模组包管理」导入或启用。</p>'
                : `<div class="lab-stack-sm" style="gap:6px;">
                    ${playablePacks
                      .map((p) => {
                        const isMatched = Boolean(actorPrimaryId && p.personalityId === actorPrimaryId);
                        const pLabel = p.personalityId ? getPersonalityName(p.personalityId) : '';
                        return `
                        <div class="lab-slot-card interact-drawer-item ${isMatched ? 'is-active' : ''}" style="padding:8px 10px; ${isMatched ? 'border-color:rgba(244,114,182,0.55); background:rgba(244,114,182,0.08);' : ''}">
                          <div class="interact-drawer-info">
                            <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                              <strong>${escapeHtml(p.name || p.title || p.id)}</strong>
                              ${
                                isMatched
                                  ? '<span class="status-badge badge-warn">💖 本性格专属</span>'
                                  : pLabel
                                  ? `<span class="status-badge badge-muted">${escapeHtml(pLabel)}</span>`
                                  : '<span class="status-badge badge-muted">通用剧场</span>'
                              }
                            </div>
                            <div class="cc-stat-sub">${(p.nodes || []).length} 幕交互节点${p.description ? ` · ${escapeHtml(String(p.description).slice(0, 34))}` : ''}</div>
                          </div>
                          <button type="button" class="${isMatched ? 'btn-primary' : 'btn-secondary'} fac-mini-btn" data-memoirs-play-pack="${escapeHtml(p.id)}">▶ 进入剧场</button>
                        </div>
                      `;
                      })
                      .join('')}
                  </div>`
            }
          </div>

          <!-- Section 1: 6-Stage Breakthrough Mini-Theatres -->
          <div class="surface-card lab-stack-sm" style="padding:10px 12px;">
            <div class="section-header-row" style="margin-bottom:0;">
              <strong style="font-size:13px;">✨ 六阶段突破小剧场（${gates.length}/5）</strong>
              <span class="status-badge badge-muted">随时重温</span>
            </div>
            ${
              gates.length === 0
                ? '<p class="muted-text" style="font-size:12px; margin:0;">尚未解锁阶段突破小剧场，与她日常交谈、赠礼或出征升温至 20 好感即可开启首段专属剧情。</p>'
                : `<div class="lab-stack-sm" style="gap:6px;">
                    ${gates
                      .map((gate) => {
                        const t = storyEngine?.getBreakthroughTheatreForGate?.(gate, { actor: sec }) || BREAKTHROUGH_THEATRES[gate];
                        if (!t) return '';
                        return `
                        <div class="lab-slot-card interact-drawer-item" style="padding:8px 10px;">
                          <div class="interact-drawer-info">
                            <strong>${escapeHtml(t.title)}</strong>
                            <div class="cc-stat-sub">好感 ${gate} 节点 · ${escapeHtml(t.fromLabel)} → ${escapeHtml(t.toLabel)}</div>
                          </div>
                          <button type="button" class="btn-secondary fac-mini-btn" data-replay-gate="${gate}">重温</button>
                        </div>
                      `;
                      })
                      .join('')}
                  </div>`
            }
          </div>

          <!-- Section 2: Oath Ceremony Replay -->
          <div class="surface-card lab-stack-sm" style="padding:10px 12px; border-color:${isOathed ? 'rgba(245,158,11,0.5)' : 'var(--border)'};">
            <div class="section-header-row" style="margin-bottom:0;">
              <strong style="font-size:13px;">💍 誓约仪式专属演出</strong>
              <span class="status-badge ${isOathed ? 'badge-warn' : 'badge-muted'}">${isOathed ? '已缔结誓约' : '未誓约'}</span>
            </div>
            ${
              isOathed
                ? `
                  <p class="muted-text" style="font-size:12px; margin:0;">
                    你们已在港区夕阳下立下永恒誓言（誓约好感上限 150）。点击下方可在聊天窗再次完整重温誓约仪式演出。
                  </p>
                  <button type="button" id="btn-memoirs-replay-oath" class="btn-primary uikit-touch-target">
                    💍 重温誓约仪式演出
                  </button>
                `
                : '<p class="muted-text" style="font-size:12px; margin:0;">好感达到 100 并完成恋慕突破后，持有誓约之戒发起誓约仪式即可解锁此专属回忆。</p>'
            }
          </div>

          <!-- Section 3: Unlocked Special Outfits Gallery -->
          <div class="surface-card lab-stack-sm" style="padding:10px 12px;">
            <div class="section-header-row" style="margin-bottom:0;">
              <strong style="font-size:13px;">👗 已解锁特殊衣装展示（${outfits.length} 套）</strong>
              <span class="status-badge badge-muted">衣柜珍藏</span>
            </div>
            ${
              outfits.length === 0
                ? '<p class="muted-text" style="font-size:12px; margin:0;">暂未收藏特殊衣装，可前往「设施 → 衣装定制馆」购置。</p>'
                : `<div class="lab-stack-sm" style="gap:6px;">
                    ${outfits
                      .map((it) => {
                        const isWearing = curOutfitId === it.id;
                        const rDef = ITEM_RARITY_MAP[it.rarity] || ITEM_RARITY_MAP.common;
                        return `
                        <div class="lab-slot-card interact-drawer-item ${isWearing ? 'is-active' : ''}" style="padding:8px 10px;">
                          <div class="interact-drawer-info">
                            <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                              <span>${getItemIconSvg(it, { size: 16 })}</span>
                              <strong>${escapeHtml(it.name)}</strong>
                              <span class="status-badge rarity-badge-${escapeHtml(it.rarity || 'common')}">${escapeHtml(rDef.label)}</span>
                            </div>
                            <div class="cc-stat-sub">${escapeHtml(it.outfitStyle || '港区特制装束')}${it.description ? ` · ${escapeHtml(it.description.slice(0, 26))}` : ''}</div>
                          </div>
                          ${
                            isWearing
                              ? '<span class="status-badge badge-ok">穿戴中</span>'
                              : `<button type="button" class="btn-secondary fac-mini-btn" data-memoirs-equip-outfit="${escapeHtml(it.id)}">试穿</button>`
                          }
                        </div>
                      `;
                      })
                      .join('')}
                  </div>`
            }
          </div>
        </div>
      `;

      body.querySelectorAll('[data-memoirs-play-pack]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const pid = btn.getAttribute('data-memoirs-play-pack');
          const pack = storyPacks?.getPack?.(pid);
          if (!pack) return;
          storyPacks.setActiveTheatreSession(pack.id, pack.entryNodeId || pack.nodes?.[0]?.id || null);
          fxStage?.playSfx?.('click');
          uiKit.showToast(`已开启剧场：「${pack.name || pack.title}」`, 'ok');
          close();
          await renderPortHub({ forceFull: true });
        });
      });

      body.querySelectorAll('[data-replay-gate]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const gate = Number(btn.getAttribute('data-replay-gate'));
          await storyEngine.startBreakthroughTheatre(sec, gate, { isReplay: true });
          close();
          await renderPortHub();
        });
      });

      body.querySelector('#btn-memoirs-replay-oath')?.addEventListener('click', async () => {
        try {
          await storyEngine.startOathRitualTheatre(sec, { isReplay: true });
          close();
          await renderPortHub();
        } catch (err) {
          uiKit.showToast(err instanceof Error ? err.message : '无法重温誓约仪式', 'warn');
        }
      });

      body.querySelectorAll('[data-memoirs-equip-outfit]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const oid = btn.getAttribute('data-memoirs-equip-outfit');
          try {
            await inventory.equipItem(sec.id, 'outfit', oid);
            await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: sec.id });
            const item = inventory.getItem(oid);
            fxStage?.playSfx?.('success');
            uiKit.showToast(`「${sec.name}」已换上「${item?.name || '特殊衣装'}」`, 'ok');
            close();
            await renderPortHub();
          } catch (err) {
            uiKit.showToast(err instanceof Error ? err.message : '换装失败', 'warn');
          }
        });
      });
    },
  });
}

// ============================================================
// Optional External Imported Story Pack Player (Zero Legacy Built-ins)
// ============================================================
function renderExternalStorySessionCard() {
  const { storyPacks, commander, uiKit } = portState.context;
  const sess = storyPacks?.getActiveTheatreSession?.();
  if (!sess || !sess.packId) return null;
  const pack = storyPacks.getPack(sess.packId);
  if (!pack || pack.builtIn) return null;

  const sec = getActiveSecretary();
  const actorName = sec?.name || '秘书舰';
  const cmdName = commander?.getProfile?.()?.name || '指挥官';
  const fmt = (str) =>
    String(str || '')
      .replaceAll('{actor.name}', actorName)
      .replaceAll('{actor}', actorName)
      .replaceAll('{commander.name}', cmdName)
      .replaceAll('{cmd}', cmdName)
      .replaceAll('{{flagship}}', actorName);

  const isCompleted = Boolean(sess.lastOutcome && !sess.lastOutcome.nextNodeId);
  const node = !isCompleted
    ? pack.nodes.find((n) => n.id === sess.nodeId) || pack.nodes[0] || null
    : null;
  const nodeCond = node && typeof storyPacks.checkConditions === 'function'
    ? storyPacks.checkConditions(node.conditions || [], { actor: sec })
    : { ok: true, unmetReasons: [] };

  const card = document.createElement('section');
  card.className = 'surface-card lab-stack-sm interact-ext-story-card';

  const lastOutcomeHtml = sess.lastOutcome
    ? `
      <div class="lab-slot-card" style="padding:8px 10px;">
        <p style="font-size:12.5px; line-height:1.65; margin:0; white-space:pre-line;">${escapeHtml(fmt(sess.lastOutcome.text || '抉择已完成。'))}</p>
        ${
          Array.isArray(sess.lastOutcome.chips) && sess.lastOutcome.chips.length > 0
            ? `<div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:6px;">
                ${sess.lastOutcome.chips
                  .map(
                    (chip) =>
                      `<span class="status-badge ${chip.negative ? 'badge-warn' : 'badge-ok'}">${escapeHtml(chip.text)}</span>`
                  )
                  .join('')}
              </div>`
            : ''
        }
      </div>
    `
    : '';

  const nodeBodyHtml = node
    ? `
      ${node.title ? `<div class="cc-stat-sub" style="font-weight:600;">${escapeHtml(fmt(node.title))}</div>` : ''}
      <p style="font-size:13px; line-height:1.65; margin:0; white-space:pre-line;">${escapeHtml(fmt(node.body || node.text || '剧情正在展开……'))}</p>
      ${
        !nodeCond.ok
          ? `<div class="status-badge badge-warn" style="white-space:normal;">前置条件未满足：${escapeHtml(nodeCond.unmetReasons.join('；'))}</div>`
          : ''
      }
      <div class="lab-stack-sm">
        ${(node.choices || [])
          .map((ch) => {
            const chCond = typeof storyPacks.checkConditions === 'function'
              ? storyPacks.checkConditions(ch.conditions || [], { actor: sec })
              : { ok: true, unmetReasons: [] };
            const unlocked = nodeCond.ok && chCond.ok;
            return `<button type="button" class="btn-secondary uikit-touch-target" data-ext-choice="${escapeHtml(ch.id)}" ${unlocked ? '' : 'disabled'}>${escapeHtml(fmt(ch.label || '继续'))}</button>`;
          })
          .join('')}
      </div>
    `
    : `<button type="button" id="btn-ext-story-finish" class="btn-primary uikit-touch-target">完成剧场并返回日常</button>`;

  card.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <strong>📖 外置剧情 · ${escapeHtml(pack.name || pack.title || '外置扩展包')}</strong>
      <button type="button" id="btn-ext-story-exit" class="btn-secondary fac-mini-btn">收起</button>
    </div>
    ${lastOutcomeHtml}
    ${nodeBodyHtml}
  `;

  const closeTheatre = () => {
    storyPacks.clearActiveTheatreSession();
    renderPortHub({ forceFull: true });
  };
  card.querySelector('#btn-ext-story-exit')?.addEventListener('click', closeTheatre);
  card.querySelector('#btn-ext-story-finish')?.addEventListener('click', closeTheatre);

  card.querySelectorAll('[data-ext-choice]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!node) return;
      const choiceId = btn.getAttribute('data-ext-choice');
      try {
        const rec = await storyPacks.executeChoice(pack.id, node.id, choiceId, { actorId: sec?.id || null });
        if (sec?.id && portState.context?.rootStorage && portState.context?.entities) {
          await persistCharacterRoster({
            storage: portState.context.rootStorage,
            entities: portState.context.entities,
            activeCharacterId: sec.id,
          });
        }
        storyPacks.updateActiveTheatreOutcome(rec, rec.nextNodeId || null);
        renderPortHub({ forceFull: true });
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
        if (res?.oathed) {
          fxStage?.playSfx?.('success');
          uiKit.showToast(`💍 已与「${sec.name}」正式缔结誓约！好感上限解放至 150，基础六维永久 +4！`, 'ok');
        } else if (res?.oathReplayed) {
          fxStage?.playSfx?.('success');
          uiKit.showToast(`💍 已重温与「${sec.name}」的誓约仪式！`, 'ok');
        } else if (res?.unlockedGate) {
          fxStage?.playSfx?.('success');
          uiKit.showToast(
            res.unlockedGate >= 100
              ? `🎉 恋慕阶段突破完成！现在可点击「💍 发起誓约」举行誓约仪式！`
              : `🎉 已突破 ${res.unlockedGate} 羁绊阶段，好感上限已解除！`,
            'ok'
          );
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

function buildAffectionCapHintText(status) {
  if (status.pendingGate) {
    return `已达阶段上限 ${status.affinity}/${status.currentCap}，完成突破剧场后继续提升`;
  }
  if (status.canStartOath) {
    return `好感已满 100/100 · 可发起誓约解放上限至 150！`;
  }
  if (status.isOathed) {
    return `💍 誓约羁绊生效：基础六维各 +4 · 出征油弹 -10% · 宿舍心情恢复加速`;
  }
  return `当前阶段上限 ${status.currentCap} · 满额后解锁阶段突破小剧场`;
}

function renderHeroStageActionsMarkup(status) {
  const memCount = (status.unlockedGates?.length || 0) + (status.isOathed ? 1 : 0);
  return `
    ${
      status.pendingGate
        ? `<button type="button" id="btn-sec-breakthrough" class="btn-primary interact-breakthrough-btn">✨ 触发阶段突破小剧场 (${status.affinity}/${status.pendingGate})</button>`
        : ''
    }
    <button type="button" id="btn-sec-memoirs" class="btn-secondary interact-mini-chip">📖 回忆录${memCount > 0 ? ` (${memCount})` : ''}</button>
    ${
      status.canStartOath
        ? `<button type="button" id="btn-sec-oath" class="btn-primary interact-breakthrough-btn">💍 发起誓约</button>`
        : ''
    }
  `;
}

function bindHeroStageActions(rootEl, sec, status) {
  const { storyEngine, entities, rootStorage, uiKit } = portState.context;
  rootEl.querySelector('#btn-sec-breakthrough')?.addEventListener('click', async () => {
    if (!status.pendingGate || portState.busy) return;
    portState.busy = true;
    try {
      await storyEngine.startBreakthroughTheatre(sec, status.pendingGate, { isReplay: false });
      await renderPortHub();
    } catch (err) {
      uiKit.showToast(err instanceof Error ? err.message : '无法开启阶段突破小剧场', 'warn');
    } finally {
      portState.busy = false;
    }
  });
  rootEl.querySelector('#btn-sec-memoirs')?.addEventListener('click', () => {
    openMemoirsDrawer(sec, status);
  });
  rootEl.querySelector('#btn-sec-oath')?.addEventListener('click', async () => {
    if (portState.busy) return;
    portState.busy = true;
    try {
      await storyEngine.startOathRitualTheatre(sec);
      await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: sec.id });
      uiKit.showToast(`💍 誓约仪式小剧场已在聊天窗开启，请选择您的誓言！`, 'ok');
      await renderPortHub();
    } catch (err) {
      uiKit.showToast(err instanceof Error ? err.message : '誓约仪式条件不足', 'warn');
    } finally {
      portState.busy = false;
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
        <div class="surface-card lab-stack-sm" style="text-align:center; padding:24px;">
          <h3 style="margin:0; font-size:16px;">港区船坞当前为空</h3>
          <p class="muted-text" style="font-size:12.5px; margin:0;">
            当前尚无执勤舰娘。您可以前往「设施 · 定向建造」建造首位舰娘，或在顶栏「自定义工坊」中自由创作专属舰娘。
          </p>
          <div class="lab-btn-grid" style="margin-top:8px;">
            <button type="button" id="btn-empty-goto-build" class="btn-primary uikit-touch-target">前往设施 · 定向建造</button>
            <button type="button" id="btn-empty-open-cw" class="btn-secondary uikit-touch-target">打开自定义工坊</button>
          </div>
        </div>
      </div>
    `;
    portState.container.querySelector('#btn-empty-goto-build')?.addEventListener('click', () => {
      portState.context?.modules?.mount?.('port-facilities-hub', { transition: 'left' });
    });
    portState.container.querySelector('#btn-empty-open-cw')?.addEventListener('click', () => {
      if (typeof window !== 'undefined' && typeof window.__APP_BASE__?.openCustomWorkshop === 'function') {
        window.__APP_BASE__.openCustomWorkshop('ship');
      }
    });
    return;
  }

  storyEngine.ensureGreeting(sec);
  const avatarUrl = await resolveShipAvatarUrl(sec);
  const status = storyEngine.getAffectionStatus(sec.id);
  const eq = inventory.getCharacterEquipment(sec.id);
  const outfitName = eq?.outfit?.name || '日常港区便装';
  const history = storyEngine.getChatHistory(sec.id);
  const activePrompt = storyEngine.getActivePrompt(sec.id);
  const displayCap = status.isOathed ? status.maxAffinity : status.currentCap;
  const affPct = Math.min(100, Math.round((status.affinity / Math.max(1, displayCap)) * 100));
  const capHintText = buildAffectionCapHintText(status);
  const liveSignature =
    typeof storyEngine.getLiveStatusSignature === 'function'
      ? storyEngine.getLiveStatusSignature(sec)
      : '港湾风平浪静，随时听候指挥官差遣。';
  const retroStage = Number(sec.meta?.retrofitStage || 0);
  const retroTag = retroStage >= 2 ? '★ 改二' : retroStage === 1 ? '★ 改' : '';
  const activeExtSess = storyPacks?.getActiveTheatreSession?.();
  const activeExtPack = activeExtSess?.packId ? storyPacks.getPack(activeExtSess.packId) : null;
  const hasExtSession = Boolean(activeExtPack && !activeExtPack.builtIn);

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
    // 1. Update hero badges, oath badge, retrofit badge, live signature, cap hint & affection bar in-place
    const oathBadge = portState.container.querySelector('#sec-oath-badge');
    if (oathBadge) {
      oathBadge.hidden = !status.isOathed;
    }
    const retroBadge = portState.container.querySelector('#sec-retrofit-badge');
    if (retroBadge) {
      retroBadge.hidden = !retroTag;
      if (retroTag) retroBadge.textContent = retroTag;
    }
    const sigEl = portState.container.querySelector('#sec-live-signature');
    if (sigEl) {
      sigEl.textContent = liveSignature;
    }
    const stageBadge = portState.container.querySelector('#sec-aff-stage-badge');
    if (stageBadge) stageBadge.textContent = `${status.stage.label}${status.isOathed ? ' 💍' : ''}`;
    const outfitEl = portState.container.querySelector('#sec-outfit-label');
    if (outfitEl) outfitEl.textContent = `着装：${outfitName}`;
    const affValEl = portState.container.querySelector('#sec-aff-val');
    if (affValEl) affValEl.textContent = String(status.affinity);
    const affMaxEl = portState.container.querySelector('#sec-aff-max');
    if (affMaxEl) affMaxEl.textContent = String(displayCap);
    const capHintEl = portState.container.querySelector('#sec-aff-cap-hint');
    if (capHintEl) {
      capHintEl.textContent = capHintText;
      capHintEl.className = `cc-stat-sub ${status.pendingGate || status.canStartOath ? 'stat-diff-inline-up' : 'muted-text'}`;
    }
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
          <div style="display:flex; align-items:center; gap:6px; min-width:0; flex-wrap:wrap;">
            <span class="ship-class-ico">${getShipClassSvg(sec.meta?.shipType, { size: 17 })}</span>
            <strong class="interact-ship-name" id="sec-name-label">${escapeHtml(sec.name)}</strong>
            <span class="status-badge badge-ok" id="sec-retrofit-badge" ${retroTag ? '' : 'hidden'}>${escapeHtml(retroTag)}</span>
            <span class="status-badge badge-warn" id="sec-oath-badge" ${status.isOathed ? '' : 'hidden'}>💍 誓约</span>
            <span class="status-badge badge-muted">Lv.${sec.stats?.level || 1}</span>
          </div>
          <div style="display:flex; gap:4px; flex-shrink:0;">
            <button type="button" id="btn-sec-profile" class="interact-icon-btn" title="查看舰娘档案">档案</button>
            <button type="button" id="btn-sec-switch" class="interact-icon-btn" title="更换秘书舰">切换</button>
          </div>
        </div>

        <div id="sec-live-signature" class="cc-stat-sub" style="font-size:11.5px; color:var(--accent); opacity:0.95; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${escapeHtml(liveSignature)}">
          ${escapeHtml(liveSignature)}
        </div>

        <div class="interact-outfit-line">
          <span class="status-badge interact-stage-pill" id="sec-aff-stage-badge">${escapeHtml(status.stage.label)}${status.isOathed ? ' 💍' : ''}</span>
          <span class="muted-text interact-outfit-name" id="sec-outfit-label">着装：${escapeHtml(outfitName)}</span>
        </div>

        <div class="interact-aff-box">
          <div class="interact-aff-head">
            <span>好感 <strong id="sec-aff-val">${status.affinity}</strong>/<span id="sec-aff-max">${displayCap}</span></span>
            <span class="muted-text" id="sec-daily-talk">今日闲聊 ${status.dailyTalkUsed}/${status.dailyTalkCap}</span>
          </div>
          <div class="interact-aff-track">
            <div class="interact-aff-fill" id="sec-aff-fill" style="width:${affPct}%"></div>
          </div>
          <div id="sec-aff-cap-hint" class="cc-stat-sub ${status.pendingGate || status.canStartOath ? 'stat-diff-inline-up' : 'muted-text'}" style="margin-top:3px; font-size:11px;">
            ${escapeHtml(capHintText)}
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
      context.bus.on('buildings:ship-retrofitted', () => renderPortHub()),
      context.bus.on('story-engine:updated', () => renderPortHub()),
      context.bus.on('story:packs-changed', () => renderPortHub({ forceFull: true })),
      context.bus.on('story:theatre-updated', () => renderPortHub({ forceFull: true })),
      context.bus.on('character:deleted', () => renderPortHub({ forceFull: true })),
      context.bus.on('character:saved', () => renderPortHub({ forceFull: true })),
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
