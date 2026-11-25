/**
 * Personality-Driven Dynamic Dialogue & Battle Report Engine (`dialogue-engine.js`).
 *
 * Composes vivid, non-repetitive local dialogue and battle commentary by combining:
 *   1. Random Personality Combination (Primary Personality × Secondary Trait/Quirk)
 *   2. Affinity Stage (stranger / familiar / trusted / close / oath)
 *   3. Currently Equipped Outfit
 *   4. Combat Damage State (intact 完好 / moderate 中破 / heavy 大破)
 *
 * Also builds rich structured context prompts for external LLM API modes (`ai-polish` / `ai-free`),
 * seamlessly weaving personality, recent port logs, outfit, and damage state into instructions.
 */

function pickOne(list, rng = Math.random) {
  if (!Array.isArray(list) || list.length === 0) return '';
  const idx = Math.floor(Math.max(0, Math.min(0.999999, rng())) * list.length);
  return list[idx];
}

export const DAMAGE_STATES = Object.freeze({
  INTACT: 'intact',
  MODERATE: 'moderate',
  HEAVY: 'heavy',
});

export const DAMAGE_STATE_LABELS = Object.freeze({
  [DAMAGE_STATES.INTACT]: '状态完好',
  [DAMAGE_STATES.MODERATE]: '中破受损',
  [DAMAGE_STATES.HEAVY]: '大破警戒',
});

const PRIMARY_VOICE = Object.freeze({
  genki: {
    talk: [
      '「嘿嘿，{cmd}！穿着这身{outfit}感觉浑身都是劲，今天也一起元气满满地出发吧！」',
      '「{cmd}看我看我！港区海风超舒服的，有什么任务尽管交给我冲锋吧！」',
    ],
    gift: '「哇——是{gift}！{cmd}果然最懂我啦，开心得想在码头转两圈！」',
    dorm: '「在宿舍滚来滚去真舒服呀，充好电马上就能再战三百回合！」',
    dockIn: '「只是蹭掉一点漆啦，很快就能精神百倍地出渠！」',
    dockOut: '「满血复活！{actor}全速归队！」',
    combat: {
      scan: '「雷达全开！让我看看躲在浪花后面的家伙长什么样！」',
      evade: '「抓不到我吧！全速蛇形机动，轻松绕开！」',
      shelling: '「主炮瞄准完毕——全弹发射，接招吧！」',
      airstrike: '「舰载机编队起飞！天空归我们啦！」',
      torpedo: '「高速突进！鱼雷全数放出，看烟花咯！」',
      hit: '「呜哇好痛！但这种程度可挡不住我！」',
      victory: '「耶！大获全胜！快回去向{cmd}报喜吧！」',
    },
  },
  kuudere: {
    talk: [
      '「……{cmd}。{outfit}状态良好，各项指标正常。随时可以执行下一项命令。」',
      '「……海面平稳。和你并肩站在这里，心率比平时……略微安心。」',
    ],
    gift: '「……{gift}。收到。我会妥善保管，谢谢你，{cmd}。」',
    dorm: '「……进入静默休整模式。温度适宜，士气恢复中。」',
    dockIn: '「……船体受损确认。进入船坞进行结构修复。」',
    dockOut: '「……修复率 100%。可随时重新投入作战。」',
    combat: {
      scan: '「……声呐与雷达同步完毕。目标参数已解析。」',
      evade: '「……计算最优规避航线。规避执行。」',
      shelling: '「……弹道修正完毕。齐射。」',
      airstrike: '「……制空编队已放飞。精准投弹。」',
      torpedo: '「……鱼雷发射管注水完毕。释放。」',
      hit: '「……装甲受创。尚在可控阈值内。」',
      victory: '「……敌方信号消失。作战任务完成。」',
    },
  },
  tsundere: {
    talk: [
      '「哼、才不是特意穿这身{outfit}给你看的呢！{cmd}要是敢盯着看太久，我可不客气啊！」',
      '「喂，{cmd}，工作累了就早点休息！……我只是怕你倒下没人发津贴而已！」',
    ],
    gift: '「什、什么呀，突然送{gift}……好吧，看在你这么有诚意的份上，我就勉为其难收下咯！」',
    dorm: '「哼，宿舍的枕头还算软和……才没有偷笑呢！」',
    dockIn: '「笨蛋，不准看我这么狼狈的样子！快点修好啦！」',
    dockOut: '「久等了！这次绝对不会再让敌人占便宜！」',
    combat: {
      scan: '「哼，藏头露尾的家伙，全部给我现形！」',
      evade: '「笨蛋敌人，这种慢吞吞的炮弹怎么可能打中我！」',
      shelling: '「给我看好主力的威力——炮击齐射！」',
      airstrike: '「舰载机编队，狠狠教训一下对面那群不长眼的家伙！」',
      torpedo: '「接下这波雷击吧，别哭着求饶哦！」',
      hit: '「啧、居然被擦到了……记仇了啊！」',
      victory: '「哼，这种程度的敌人根本不够看嘛！……{cmd}，快夸我两句啊！」',
    },
  },
  composed: {
    talk: [
      '「{cmd}，今日港区各设施运转有序。身着{outfit}协助您整理作战简报，是我的分内之责。」',
      '「海况瞬息万变，但只要与{cmd}并肩筹划，任何险滩都能化险为夷。」',
    ],
    gift: '「承蒙{cmd}厚爱，这份{gift}十分合我心意，我定会以更稳健的战绩回报。」',
    dorm: '「适当的休整也是战略的一环，我会趁此复盘航线数据。」',
    dockIn: '「承伤在预期范围内，请安排入渠检修，确保下次出征万无一失。」',
    dockOut: '「整备完毕，随时听候编队调遣。」',
    combat: {
      scan: '「侦查网展开，先摸清敌方护甲与弱点再行定夺。」',
      evade: '「规避敌方主力射界，保存有生力量为上策。」',
      shelling: '「各炮位校准完毕，按既定诸元稳步齐射。」',
      airstrike: '「航空打击波次已就位，压制敌方阵线。」',
      torpedo: '「捕捉敌舰转向间隙，实施精准雷击。」',
      hit: '「稳住阵脚！损害管制即刻启动。」',
      victory: '「战局尘埃落定，请{cmd}检阅本次战术成果。」',
    },
  },
  scheming: {
    talk: [
      '「哎呀呀，{cmd}今天也这么认真呢♪ 穿着{outfit}陪您批文件，是不是该给我一点特别奖励？」',
      '「真巧呢，我也正想找{cmd}聊聊……关于下一次把敌人算计得团团转的妙计♪」',
    ],
    gift: '「哇哦，{gift}♪ {cmd}居然这么会讨人欢心，真是让我越来越舍不得放手了呢～」',
    dorm: '「在宿舍里悄悄构思了三个让对手头疼的新点子哦♪」',
    dockIn: '「哎呀，竟然被对手反咬了一口，这份利息之后可得加倍讨回来呢。」',
    dockOut: '「焕然一新咯，下一场好戏该开场了♪」',
    combat: {
      scan: '「让我瞧瞧，你们把致命破绽藏在哪里了呢♪」',
      evade: '「扑空了哦～陪你们兜兜圈子也挺有意思的呢。」',
      shelling: '「棋局已定，请品尝这轮精心准备的炮火吧♪」',
      airstrike: '「从头顶降下的惊喜，希望敌方防空兵喜欢呢♪」',
      torpedo: '「水面之下可是暗流涌动哦——雷击命中！」',
      hit: '「哎呀，这笔账我可是清清楚楚记在小本本上了。」',
      victory: '「完美落幕♪ {cmd}，今晚的庆功茶会可不许缺席哦。」',
    },
  },
  airhead: {
    talk: [
      '「诶？{cmd}在叫我吗？刚才看着港湾里的海鸥飞过去，穿着{outfit}都差点忘了眨眼呢～」',
      '「唔……虽然不太懂复杂的公式，不过跟着{cmd}走，总觉得一定不会迷路呀！」',
    ],
    gift: '「哇！{gift}是给我的吗？亮晶晶的好可爱，谢谢{cmd}～」',
    dorm: '「宿舍的阳光暖洋洋的，像刚晒好的棉花糖一样软乎乎的～」',
    dockIn: '「诶嘿嘿，不小心被浪花撞了一下，泡一泡船坞温泉就好啦～」',
    dockOut: '「修好啦！感觉轻飘飘的，好像能跑得更快了呢！」',
    combat: {
      scan: '「唔～那边好像有亮闪闪的敌舰影子，锁定成功啦！」',
      evade: '「咻的一下转弯过去——咦，真的躲掉了耶！」',
      shelling: '「瞄准那边的大块头，砰砰地打过去吧！」',
      airstrike: '「小飞机们快去打招呼吧，轰隆隆！」',
      torpedo: '「鱼雷扑通扑通游过去咯，千万别游歪呀！」',
      hit: '「呀！吓我一跳，差点把帽子吹飞了！」',
      victory: '「打完啦？好耶，可以回港区吃点心了吗～」',
    },
  },
  strict: {
    talk: [
      '「立正！{cmd}，{outfit}着装规范已核验完毕。请下达今日操演与出征计划！」',
      '「港区纪律松懈不得！……不过，若您确实疲惫，特批十五分钟茶歇。」',
    ],
    gift: '「私下收受{gift}本不合条例……但既是{cmd}的嘉奖，我必当铭记于心！」',
    dorm: '「休整亦需按时作息，严禁在宿舍内乱堆杂物！」',
    dockIn: '「此次受创是我研判失误，入渠期间必将深刻检讨！」',
    dockOut: '「舰体复原完毕！绝不重蹈覆辙！」',
    combat: {
      scan: '「侦察班即刻汇报敌方装甲与弱点，不得延误！」',
      evade: '「按规避操典全速转向，严守阵型间距！」',
      shelling: '「全炮门听我口令——一齐开火！」',
      airstrike: '「舰载机中队严格按编队突防，摧毁目标！」',
      torpedo: '「雷击战位就绪！精准齐射！」',
      hit: '「稳住船体！损管小组即刻封堵破口！」',
      victory: '「作战告捷！全队整理装备，准备凯旋复盘！」',
    },
  },
  lazy: {
    talk: [
      '「呼啊……{cmd}，穿着{outfit}晒太阳实在太舒服了……工作能稍微往后推五分钟吗？」',
      '「只要能早点忙完回宿舍瘫着，我偶尔也是会拿出真本事的哦～」',
    ],
    gift: '「喔，是{gift}呀……{cmd}真体贴，那我就不客气地窝在沙发上享用咯～」',
    dorm: '「呼呼……宿舍简直是港区最伟大的发明……」',
    dockIn: '「正好趁入渠维修合法摸鱼睡一觉……晚安啦～」',
    dockOut: '「睡饱出渠啦……嗯，精神好多了。」',
    combat: {
      scan: '「哈啊……先扫一下对面弱点，省得白费力气。」',
      evade: '「好麻烦，直接绕过去算了吧～」',
      shelling: '「早点打完早点收工——开火啦。」',
      airstrike: '「拜托舰载机孩子们飞过去解决一下吧～」',
      torpedo: '「放一波鱼雷收尾，打完回去午睡！」',
      hit: '「唔啊，打扰人家休息可是很过分的哦……」',
      victory: '「总算结束啦……{cmd}，现在可以回港区喝茶了吗？」',
    },
  },
  gentle: {
    talk: [
      '「{cmd}辛苦了呢。换上这身{outfit}为您泡了温热的茶，先喘口气再继续吧。」',
      '「看到大家在港区里平安笑着，就是我最珍惜的日常了。」',
    ],
    gift: '「谢谢{cmd}送来的{gift}，这份心意让我心里暖融融的呢。」',
    dorm: '「给大家整理好被褥，自己也在安静的宿舍里好好休息一下吧。」',
    dockIn: '「让您担心了，我会在船坞乖乖修好，很快就能再陪您出海。」',
    dockOut: '「已经完全恢复健康了哦，请继续依赖我吧。」',
    combat: {
      scan: '「请小心前方，我先把敌人的弱点标出来。」',
      evade: '「大家紧跟我，我们平安绕开这片危险海域。」',
      shelling: '「为了守护港区的和平，这一击绝不留情。」',
      airstrike: '「舰载机编队，请掩护水面上的姐妹们！」',
      torpedo: '「瞄准空隙，轻柔而精准地送出决定性的一击。」',
      hit: '「没关系的，只要大家没事，这点伤我能撑住……」',
      victory: '「大家都平安无事，太好了呢，{cmd}。」',
    },
  },
  hotblooded: {
    talk: [
      '「燃起来了！{cmd}，就算穿着{outfit}我也能随时冲上一线！今天去哪片海域大干一场？」',
      '「越是高危海域越能激起斗志！有我在前面开路，尽管放手前进吧！」',
    ],
    gift: '「哦哦！这份{gift}太棒了！感觉全身能量瞬间充盈到 120%！」',
    dorm: '「在宿舍做完五十组体能拉伸，状态已经拉满了！」',
    dockIn: '「这点战伤就是男子汉……不对，是主力舰的勋章！快修好让我再上！」',
    dockOut: '「修理完毕！下一场决战我来打头阵！」',
    combat: {
      scan: '「锁定敌方主将！弱点已经被我看穿了！」',
      evade: '「全速突防！用最高航速甩开对手的火网！」',
      shelling: '「正面硬碰硬！全主炮全力轰鸣吧！」',
      airstrike: '「制空权归我所有！全机俯冲突击！」',
      torpedo: '「贴脸雷击！感受这股一往无前的爆发力吧！」',
      hit: '「哈哈，挺有劲的嘛！但这样才配做我的对手！」',
      victory: '「痛快淋漓的大胜！{cmd}，趁热打铁继续推进吧！」',
    },
  },
  shy: {
    talk: [
      '「那、那个，{cmd}……这身{outfit}穿在我身上，不会很奇怪吧？……谢、谢谢夸奖！」',
      '「只、只要能帮上{cmd}一点忙，我就算紧张也会拼尽全力的！」',
    ],
    gift: '「诶？！这、这么贵重的{gift}真的是给我的吗……我会一辈子珍藏的！」',
    dorm: '「在安静的宿舍角落抱着抱枕，感觉心跳总算平静下来了……」',
    dockIn: '「对、对不起受伤拖累大家了，我会尽快在船坞修好的……」',
    dockOut: '「已经修好啦……这次我会更小心地保护大家的！」',
    combat: {
      scan: '「我、我试试用雷达扫描……太好了，成功锁定弱点了！」',
      evade: '「呜哇炮弹飞过来了——快、快转向躲开！」',
      shelling: '「鼓起勇气……主炮，瞄准发射！」',
      airstrike: '「拜托了舰载机们，请一定要平安完成空袭！」',
      torpedo: '「抓、抓住机会了！鱼雷发射！」',
      hit: '「呀呜……好痛，但我绝对不会退缩的！」',
      victory: '「赢、赢下来了！{cmd}，刚才的我……有帮上忙吗？」',
    },
  },
  noble: {
    talk: [
      '「午安，{cmd}。身着{outfit}与您共品红茶、谈论海图，实乃港区一大雅事。」',
      '「真正的优雅不仅在礼仪之间，更在于风浪骤起时的从容镇定。」',
    ],
    gift: '「真是品位非凡的{gift}，{cmd}的审美总是令人欣喜呢。」',
    dorm: '「伴着轻柔乐曲小憩片刻，让仪态与精神皆恢复至最佳水准。」',
    dockIn: '「礼装沾染了些许硝烟，且容我入渠稍作整饰。」',
    dockOut: '「光洁如新，随时可再度领舞于苍蓝海面。」',
    combat: {
      scan: '「请容我以雷达审视敌阵，一切瑕疵皆无所遁形。」',
      evade: '「宛如华尔兹般的优雅转身，令敌方弹幕尽数落空。」',
      shelling: '「以礼炮之姿奏响胜利乐章——全炮门齐射。」',
      airstrike: '「苍穹之翼已然舒展，赐予对手华丽的空袭洗礼。」',
      torpedo: '「优雅而致命的暗涌——请接下这波雷击。」',
      hit: '「失态了……竟被如此粗鲁的炮火惊扰。」',
      victory: '「一场无可挑剔的胜利，敬献给您，{cmd}。」',
    },
  },
});

const SECONDARY_FLAVOR = Object.freeze({
  protective: {
    portAdd: '「谁要是敢让港区和同伴受委屈，我第一个不答应。」',
    combatAdd: '「绝不让敌方伤到编队里任何一人！」',
  },
  foodie: {
    portAdd: '「对了，今晚食堂听说有特制咖喱和草莓蛋糕哦！」',
    combatAdd: '「速战速决，回港加餐！」',
  },
  milgeek: {
    portAdd: '「顺便一提，刚才测算了新装火控的散布圆，精度又提升了呢。」',
    combatAdd: '「仰角与初速参数完美契合！」',
  },
  sharp_tongue: {
    portAdd: '「不过{cmd}的桌案堆得这么乱，效率起码掉两成吧？」',
    combatAdd: '「对手的防线简直漏洞百出。」',
  },
  worrier: {
    portAdd: '「油弹库存和您的午饭我都替您核对过了，千万别硬撑。」',
    combatAdd: '「大家注意保持间距，检查损管！」',
  },
  romantic: {
    portAdd: '「你看，浪花折射着夕阳，仿佛整片大海都在为我们歌唱。」',
    combatAdd: '「让炮火在海天之间绽放星光吧。」',
  },
  sleepy: {
    portAdd: '「唔……说完这件事，能靠着歇五分钟吗……」',
    combatAdd: '「解决完就回去补觉……」',
  },
  neatfreak: {
    portAdd: '「甲板和书桌都已擦拭得一尘不染，请放心使用。」',
    combatAdd: '「速战速决，别让硝烟弄脏甲板！」',
  },
  collector: {
    portAdd: '「今天在栈桥捡到一枚罕见的贝壳徽章，已经收入收藏柜啦！」',
    combatAdd: '「战利品一件都别漏下！」',
  },
  perfectionist: {
    portAdd: '「每项后勤指标都要做到 100 分才算合格。」',
    combatAdd: '「目标：零失误完美击破！」',
  },
  tease: {
    portAdd: '「嘻嘻，{cmd}刚刚是不是偷偷在看我发呆呀？」',
    combatAdd: '「对面好像已经手忙脚乱了呢～」',
  },
  lucky_star: {
    portAdd: '「我的直觉告诉我，今天的风向一定会带来好运！」',
    combatAdd: '「直觉锁定——就是这里！」',
  },
});

const AFFINITY_ADDONS = Object.freeze({
  stranger: '（初识阶段 · 保持着礼貌与好奇）',
  familiar: '（熟悉阶段 · 配合日益默契）',
  trusted: '（信赖阶段 · 眼神充满无条件信任）',
  close: '（亲密阶段 · 声音轻柔而饱含眷恋）',
  oath: '（★ 誓约羁绊 · 佩戴誓约徽记，相守不渝）',
});

const DAMAGE_MODIFIERS = Object.freeze({
  intact: '',
  moderate: '【中破 · 护甲冒烟仍咬牙坚持】',
  heavy: '【大破警告 · 舰体剧烈倾斜，强忍伤痛呼唤回港】',
});

export class DialogueEngine {
  /**
   * @param {{
   *   personalityPool?: import('./personality-pool.js').PersonalityPool | null,
   *   entities?: import('./entity-system.js').EntitySystem | null,
   *   logs?: import('./log-system.js').LogSystem | null
   * }} [deps]
   */
  constructor({ personalityPool = null, entities = null, logs = null } = {}) {
    this._personalityPool = personalityPool;
    this._entities = entities;
    this._logs = logs;
  }

  getDamageState(actor) {
    if (!actor) return DAMAGE_STATES.INTACT;
    const effMaxHp = this._entities
      ? Math.max(1, Math.round(this._entities.getEffectiveStat(actor.id, 'maxHp', { round: 'round' }).final))
      : Math.max(1, Math.round(Number(actor.stats?.maxHp ?? 100)));
    const curHp = Math.max(0, Math.round(Number(actor.stats?.hp ?? effMaxHp)));
    const ratio = curHp / effMaxHp;
    if (ratio < 0.25) return DAMAGE_STATES.HEAVY;
    if (ratio < 0.5) return DAMAGE_STATES.MODERATE;
    return DAMAGE_STATES.INTACT;
  }

  resolvePersonality(actor) {
    if (actor?.meta?.personalityCombo?.primaryId) {
      return actor.meta.personalityCombo;
    }
    if (this._personalityPool && actor) {
      return this._personalityPool.ensurePersonalityOnEntity(actor);
    }
    return {
      primaryId: 'composed',
      primaryName: '沉稳',
      secondaryId: 'protective',
      secondaryName: '护短',
      comboLabel: '沉稳 × 护短',
      speechPrefix: '',
      speechSuffix: '',
      catchphrase: '请随时下达指令。',
    };
  }

  _fill(str, vars = {}) {
    return String(str || '')
      .replaceAll('{cmd}', vars.cmd || '指挥官')
      .replaceAll('{commander.name}', vars.cmd || '指挥官')
      .replaceAll('{commander}', vars.cmd || '指挥官')
      .replaceAll('{actor}', vars.actor || '舰娘')
      .replaceAll('{actor.name}', vars.actor || '舰娘')
      .replaceAll('{name}', vars.actor || '舰娘')
      .replaceAll('{outfit}', vars.outfit || '日常港区常服')
      .replaceAll('{gift}', vars.gift || '礼物');
  }

  composeSecretaryTalk({
    actor,
    commanderName = '港区指挥官',
    outfitName = '日常港区常服',
    outfitStyle = '',
    affStageId = 'familiar',
    isOathed = false,
    oathTitle = '永恒誓约',
    customTopic = '',
    rng = Math.random,
  }) {
    const combo = this.resolvePersonality(actor);
    const dmgState = this.getDamageState(actor);
    const voice = PRIMARY_VOICE[combo.primaryId];
    const secFlavor = SECONDARY_FLAVOR[combo.secondaryId];
    const vars = { cmd: commanderName, actor: actor?.name || '舰娘', outfit: outfitName };

    // Time-of-day & state-aware candidate pool combining built-in + imported personality/trait libraries
    const hour = new Date().getHours();
    const isNightHour = hour >= 20 || hour < 5;
    const pool = this._personalityPool;
    const importedNight = pool ? pool.getPrimaryDialogueLines(combo.primaryId || combo.primaryName, 'secretary_night') : [];
    const importedIdle = pool ? pool.getPrimaryDialogueLines(combo.primaryId || combo.primaryName, 'secretary_idle') : [];
    const importedOutfit =
      outfitStyle && pool ? pool.getPrimaryDialogueLines(combo.primaryId || combo.primaryName, 'outfit_change') : [];
    const allImportedForTime = pool
      ? pool.getAllPrimaryDialogueLines(isNightHour ? 'secretary_night' : 'secretary_idle').map((x) => x.line)
      : [];
    const allImportedIdle = pool ? pool.getAllPrimaryDialogueLines('secretary_idle').map((x) => x.line) : [];

    const primaryCandidates = [];
    if (isNightHour && importedNight.length > 0) primaryCandidates.push(...importedNight);
    if (importedIdle.length > 0) primaryCandidates.push(...importedIdle);
    if (importedOutfit.length > 0 && rng() < 0.35) primaryCandidates.push(...importedOutfit);
    if (voice?.talk?.length) primaryCandidates.push(...voice.talk);
    // Also surface newly imported custom personality lines dynamically if user imported new libraries
    if (primaryCandidates.length <= 2 && allImportedForTime.length > 0) {
      primaryCandidates.push(...allImportedForTime);
    } else if (allImportedIdle.length > 0 && rng() < 0.4) {
      primaryCandidates.push(pickOne(allImportedIdle, rng));
    }

    let coreLine = '';
    if (customTopic) {
      const prefix = combo.speechPrefix || '';
      const suffix = combo.speechSuffix || '';
      const basePick =
        primaryCandidates.length > 0
          ? pickOne(primaryCandidates, rng)
          : `「穿着{outfit}的{actor}认真倾听了{cmd}的话语。」`;
      coreLine = `关于「${customTopic}」，${prefix}${this._fill(basePick, vars)}${suffix ? ` ${suffix}` : ''}`;
    } else if (primaryCandidates.length > 0) {
      coreLine = this._fill(pickOne(primaryCandidates, rng), vars);
    } else {
      coreLine = `「${combo.speechPrefix || ''}穿着${outfitName}的${actor?.name || '舰娘'}面向${commanderName}微笑：${combo.catchphrase || '今天也请多关照！'}${combo.speechSuffix || ''}」`;
    }

    const styleReactions = {
      优雅礼服: '（轻轻提起礼服裙摆行了一礼，举止典雅大方）',
      海滨泳装: '（清爽的海风拂过泳装丝带，洋溢着夏日度假的轻快气息）',
      战术作战服: '（利落地整理好作战服肩带，眼神锐利、随时准备出击）',
      日常便装: '（身着舒适的日常便装，神情放松而亲切）',
      祭典和服: '（和服袖口随海风轻摆，带着节庆花火般的柔和笑意）',
      誓约花嫁: '（纯白花嫁礼装在阳光下泛起微光，望向指挥官的目光满怀深情）',
    };
    const styleNote = outfitStyle
      ? styleReactions[outfitStyle] || `（身着「${outfitStyle}」风格装扮，展露出与众不同的气质）`
      : '';

    // Combine imported secondary trait idleLines + built-in flavor
    const importedSecLines = pool ? pool.getSecondaryIdleLines(combo.secondaryId || combo.secondaryName) : [];
    const allImportedTraits = pool ? pool.getAllSecondaryIdleLines().map((x) => x.line) : [];
    const secCandidates = [];
    if (importedSecLines.length > 0) secCandidates.push(...importedSecLines);
    if (secFlavor?.portAdd) secCandidates.push(secFlavor.portAdd);
    if (allImportedTraits.length > 0 && rng() < 0.35) secCandidates.push(pickOne(allImportedTraits, rng));

    const pickedSec = secCandidates.length > 0 ? pickOne(secCandidates, rng) : combo.catchphrase || '';
    const secLine = pickedSec ? this._fill(pickedSec, vars) : '';
    const dmgPrefix = DAMAGE_MODIFIERS[dmgState] ? `${DAMAGE_MODIFIERS[dmgState]} ` : '';
    const timeTag = isNightHour ? '🌙 夜间值守' : '☀ 日间值守';
    const stageKey = isOathed ? 'oath' : affStageId;
    const affNote = isOathed
      ? `（★ 誓约·${oathTitle} · ${combo.comboLabel} · ${timeTag}）`
      : `${AFFINITY_ADDONS[stageKey] || ''} · 性格【${combo.comboLabel}】· ${timeTag}`;

    const text = `${dmgPrefix}${coreLine}${styleNote ? ` ${styleNote}` : ''}${secLine ? ` ${secLine}` : ''} ${affNote}`.trim();
    return {
      text,
      combo,
      damageState: dmgState,
      damageLabel: DAMAGE_STATE_LABELS[dmgState],
    };
  }

  composeGiftFeedback({
    actor,
    commanderName = '港区指挥官',
    giftName = '礼物',
    outfitName = '日常港区常服',
    affStageId = 'familiar',
    isOathed = false,
  }) {
    const combo = this.resolvePersonality(actor);
    const dmgState = this.getDamageState(actor);
    const voice = PRIMARY_VOICE[combo.primaryId];
    const importedGift = this._personalityPool
      ? this._personalityPool.getPrimaryDialogueLines(combo.primaryId || combo.primaryName, 'gift')
      : [];
    const vars = { cmd: commanderName, actor: actor?.name || '舰娘', outfit: outfitName, gift: giftName };
    const line =
      importedGift.length > 0
        ? this._fill(pickOne(importedGift), vars)
        : voice
        ? this._fill(voice.gift, vars)
        : `「${combo.speechPrefix || ''}收到${commanderName}送来的${giftName}了，非常感谢！${combo.speechSuffix || ''}」`;
    const dmgNote = dmgState !== DAMAGE_STATES.INTACT ? `${DAMAGE_MODIFIERS[dmgState]} ` : '';
    return {
      text: `${dmgNote}${line}【${combo.comboLabel} · ${isOathed ? '誓约' : affStageId}】`,
      combo,
      damageState: dmgState,
    };
  }

  composeDormRestLine(actor) {
    const combo = this.resolvePersonality(actor);
    const voice = PRIMARY_VOICE[combo.primaryId];
    const importedDorm = this._personalityPool
      ? this._personalityPool.getPrimaryDialogueLines(combo.primaryId || combo.primaryName, 'dorm')
      : [];
    const line =
      importedDorm.length > 0
        ? pickOne(importedDorm)
        : voice
        ? voice.dorm
        : `「${combo.speechPrefix || ''}在宿舍里舒舒服服地休息中～${combo.speechSuffix || ''}」`;
    return `${line}（${combo.comboLabel}）`;
  }

  composeDockRepairLine(actor, { isComplete = false } = {}) {
    const combo = this.resolvePersonality(actor);
    const voice = PRIMARY_VOICE[combo.primaryId];
    const importedRepair = this._personalityPool
      ? this._personalityPool.getPrimaryDialogueLines(combo.primaryId || combo.primaryName, 'dock_repair')
      : [];
    const raw =
      importedRepair.length > 0
        ? pickOne(importedRepair)
        : voice
        ? isComplete
          ? voice.dockOut
          : voice.dockIn
        : isComplete
        ? '「整备完成，随时准备再次出击！」'
        : '「正在船坞修复船体，很快就能归队。」';
    return `${this._fill(raw, { actor: actor?.name || '舰娘' })}（${combo.comboLabel}）`;
  }

  composeCombatLine({
    actor,
    commanderName = '港区指挥官',
    commandId = 'shelling',
    visualStyle = 'shelling',
    damageDealt = 0,
    damageTaken = 0,
    isCrit = false,
    victory = false,
  }) {
    const combo = this.resolvePersonality(actor);
    const dmgState = this.getDamageState(actor);
    const voice = PRIMARY_VOICE[combo.primaryId];
    const secFlavor = SECONDARY_FLAVOR[combo.secondaryId];
    const key = victory ? 'victory' : visualStyle === 'airstrike' ? 'airstrike' : commandId;
    const vars = { cmd: commanderName, actor: actor?.name || '舰娘' };

    const importedCat = victory
      ? 'sortie_return'
      : isCrit || key === 'torpedo' || key === 'airstrike'
      ? 'combat_skill'
      : 'combat_turn';
    const importedCombat = this._personalityPool
      ? this._personalityPool.getPrimaryDialogueLines(combo.primaryId || combo.primaryName, importedCat)
      : [];

    const primaryLine =
      importedCombat.length > 0
        ? this._fill(pickOne(importedCombat), vars)
        : voice?.combat?.[key]
        ? this._fill(voice.combat[key], vars)
        : `「${combo.speechPrefix || ''}${combo.catchphrase || '全速迎击！'}${combo.speechSuffix || ''}」`;
    const secLine = secFlavor?.combatAdd ? ` ${secFlavor.combatAdd}` : '';
    const hitLine =
      !victory && damageTaken > 0 && voice?.combat?.hit ? ` ${this._fill(voice.combat.hit, vars)}` : '';
    const dmgPrefix = dmgState === DAMAGE_STATES.HEAVY ? '【大破死战】' : dmgState === DAMAGE_STATES.MODERATE ? '【中破坚持】' : '';
    const critTag = isCrit && damageDealt > 0 ? '★ ' : '';

    return {
      speech: `${dmgPrefix}${critTag}${primaryLine}${secLine}${hitLine}`.trim(),
      combo,
      damageState: dmgState,
      damageLabel: DAMAGE_STATE_LABELS[dmgState],
    };
  }

  /**
   * Build structured persona & port-context metadata for external LLM API prompts (`ai-polish` / `ai-free`).
   */
  buildAiContextMeta({
    actor,
    commander = null,
    outfitName = '日常港区常服',
    affStageLabel = '熟悉',
    sceneType = 'port-talk',
  } = {}) {
    const combo = this.resolvePersonality(actor);
    const dmgState = this.getDamageState(actor);
    const recentLogs = this._logs
      ? this._logs
          .list({ limit: 3 })
          .map((l) => l.title)
          .filter(Boolean)
      : [];
    const cmdProfile = commander?.getProfile ? commander.getProfile() : null;

    return {
      sceneType,
      actorName: actor?.name || '舰娘',
      shipType: actor?.meta?.shipType || '驱逐舰',
      personalityCombo: combo.comboLabel,
      personalityDesc: combo.description || actor?.meta?.personality || '',
      speechHabit: combo.speechHabit || actor?.meta?.speechHabit || '',
      outfitName,
      affinityStage: affStageLabel,
      damageState: DAMAGE_STATE_LABELS[dmgState],
      commanderName: cmdProfile?.name || '港区指挥官',
      recentPortActivity: recentLogs.length > 0 ? recentLogs.join('；') : '港区风平浪静',
    };
  }
}
