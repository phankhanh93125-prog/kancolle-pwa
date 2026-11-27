/**
 * Built-In Natural Conversational Dialogues, 6-Stage Slow Affection System,
 * Breakthrough Mini-Theatres, Portrait Touch Reactions & Maritime Encounters (`src/data/default-dialogues.js`).
 *
 * 100% compatible with external imported JSON dialogue/story packs (which automatically merge/override cleanly).
 */

export const AFFINITY_STAGES_6 = Object.freeze([
  { index: 0, id: 'stranger', label: '陌生', min: 0, max: 20, gateAfter: 20, tone: '礼貌克制、略带距离感' },
  { index: 1, id: 'familiar', label: '熟悉', min: 20, max: 40, gateAfter: 40, tone: '轻松自然、愿意搭话' },
  { index: 2, id: 'trusted', label: '信赖', min: 40, max: 60, gateAfter: 60, tone: '默契坦诚、彼此托付' },
  { index: 3, id: 'flutter', label: '心动', min: 60, max: 80, gateAfter: 80, tone: '细微羞赧、藏不住在意' },
  { index: 4, id: 'adoration', label: '恋慕', min: 80, max: 100, gateAfter: 100, tone: '温柔依恋、私密亲近' },
  { index: 5, id: 'oath', label: '誓约', min: 100, max: 150, gateAfter: null, tone: '长相厮守、心照不宣' },
]);

export const BREAKTHROUGH_GATES = Object.freeze([20, 40, 60, 80, 100]);

export function resolveAffinityStage6(affinity = 0, { isOathed = false, unlockedGates = null } = {}) {
  const val = Math.max(0, Math.round(Number(affinity) || 0));
  if (isOathed) return AFFINITY_STAGES_6[5];

  if (unlockedGates) {
    const set = unlockedGates instanceof Set ? unlockedGates : new Set(unlockedGates);
    if (!set.has(20)) return AFFINITY_STAGES_6[0];
    if (!set.has(40)) return AFFINITY_STAGES_6[1];
    if (!set.has(60)) return AFFINITY_STAGES_6[2];
    if (!set.has(80)) return AFFINITY_STAGES_6[3];
    return AFFINITY_STAGES_6[4];
  }

  if (val > 100) return AFFINITY_STAGES_6[5];
  if (val >= 80) return AFFINITY_STAGES_6[4];
  if (val >= 60) return AFFINITY_STAGES_6[3];
  if (val >= 40) return AFFINITY_STAGES_6[2];
  if (val >= 20) return AFFINITY_STAGES_6[1];
  return AFFINITY_STAGES_6[0];
}

export function getTimeOfDayBucket(date = new Date()) {
  const h = date.getHours();
  return h >= 20 || h < 6 ? 'night' : 'day';
}

/**
 * Multi-dimensional daily conversational lines (6 stages x day/night).
 * Each item has optional subtle `narration` (action/expression) + natural spoken `text`,
 * plus optional `choices` for interactive bubble replies.
 */
export const DEFAULT_DIALOGUE_BANK = Object.freeze({
  stranger: {
    day: [
      {
        narration: '{actor}把整理好的执勤表放到桌角，站姿端正地看向你。',
        text: '「{cmd}，早上的巡逻清单我都核对好了。有什么需要我顺手处理的，直接说就行。」',
        choices: [
          { label: '辛苦了，先坐下喝杯水吧', reply: '「……那我就不客气了。谢谢{cmd}，其实不用这么客气的。」', narration: '{actor}愣了一下，轻轻拉开椅子坐下，耳尖微微放松。' },
          { label: '帮我再核对一下补给舱库存', reply: '「明白，我马上去核对油弹账本，二十分钟后向您汇报。」', narration: '{actor}利落地敬了个礼，翻开随身记录本。' },
        ],
      },
      {
        narration: '窗外海鸥掠过防波堤，{actor}顺手理了理身上的{outfit}。',
        text: '「港区比我想象的安静呢。不过这样也好，做事不容易分心。」',
      },
      {
        narration: '{actor}目光停在海图边缘，声音清淡而礼貌。',
        text: '「刚调任过来，很多习惯还在适应中。如果我有哪里做得不够好，请直接指出来。」',
      },
    ],
    night: [
      {
        narration: '深夜值班室只亮着一盏暖色台灯，{actor}轻声敲了敲门。',
        text: '「{cmd}，已经很晚了。夜航信号灯我都巡查完毕了，您也要早点休息。」',
      },
      {
        narration: '海面一片漆黑，{actor}把一份热茶推到你手边后退了半步。',
        text: '「夜里海风凉，泡了点清茶。没别的事我就先去走廊值守了。」',
      },
    ],
  },
  familiar: {
    day: [
      {
        narration: '{actor}靠在窗边伸了个小懒腰，转头朝你弯起眼睛。',
        text: '「{cmd}，今天食堂的烤鱼闻起来超香的，一会儿忙完要不要一起去看看？」',
        choices: [
          { label: '好啊，我请客加一份甜点', reply: '「真的吗？那说好了不许反悔哦，我可记在小本本上了！」', narration: '{actor}眼睛一亮，心情肉眼可见地轻快起来。' },
          { label: '等我批完这份航线单就去', reply: '「行，那我就在旁边等你，顺便帮把已经签好的文件收起来。」', narration: '{actor}自然地走到桌边，动作熟稔地替你理纸。' },
        ],
      },
      {
        narration: '{actor}轻轻晃了晃手里的咖啡杯，语气轻松了许多。',
        text: '「最近跟你一起执勤，感觉节奏顺手多了。至少不会像刚来那天一样紧张得同手同脚啦。」',
      },
      {
        narration: '阳光洒在{outfit}的衣角，{actor}随口聊起港区趣事。',
        text: '「刚才在码头碰到几只胖橘猫，居然敢追着补给车要小鱼干，真是越养越胆大了。」',
      },
    ],
    night: [
      {
        narration: '台灯的光晕落在{actor}侧脸上，她小声打了个哈欠。',
        text: '「{cmd}，这么晚还在盯海图啊？偶尔也该放过自己，明天再看也来得及。」',
      },
      {
        narration: '{actor}把窗帘拉拢了些，挡住带着潮气的夜风。',
        text: '「夜里的港区挺舒服的，只有浪声和灯光。陪你聊两句再回宿舍好了。」',
      },
    ],
  },
  trusted: {
    day: [
      {
        narration: '{actor}把刚整理好的作战简报递过来，指尖不经意擦过你的手背。',
        text: '「下一次出征不管分到哪条航道，把最难啃的那段交给我吧。你在后面指挥，我心里有底。」',
        choices: [
          { label: '别太逞强，平安回来最重要', reply: '「知道啦，我会顾好自己的。……被你这么叮嘱，总觉得不能让你失望呢。」', narration: '{actor}嘴角扬起一抹浅笑，神色格外认真。' },
          { label: '有你在前线我确实安心很多', reply: '「嘿嘿，那这份信赖我可要好好收下咯。回头可别忘了给我记头功。」', narration: '{actor}轻轻拍了拍胸口，眼神清亮而坚定。' },
        ],
      },
      {
        narration: '{actor}熟练地替你把茶杯续上温水，神情自然得像多年搭档。',
        text: '「其实我以前不太爱跟人说心里话，但在你这儿好像不用绷着。是不是有点太惯着我了？」',
      },
      {
        narration: '微风拂过阳台，{actor}侧头看着你笑了一声。',
        text: '「穿着这身{outfit}站在你身边久了，连港区的海风味道都觉得特别熟悉。」',
      },
    ],
    night: [
      {
        narration: '夜色静谧，{actor}拖了张凳子坐到你桌旁，声音放得很轻。',
        text: '「睡不着的时候，只要来看看你还在亮着灯，就觉得今晚的海面一定很安稳。」',
      },
      {
        narration: '{actor}把一件薄披肩搭在椅背上，轻声提醒。',
        text: '「{cmd}，你每次专心做事都忘了时间。再过十分钟我就强行帮你合上文件夹了哦。」',
      },
    ],
  },
  flutter: {
    day: [
      {
        narration: '{actor}看着你走近，下意识抿了抿唇，视线短暂错开又悄悄转回来。',
        text: '「{cmd}……今天这身{outfit}，你觉得好看吗？其实出门前在镜子前面犹豫了好久呢。」',
        choices: [
          { label: '非常衬你，一眼就移不开视线', reply: '「唔、你说话怎么突然这么直接呀……不过，听到你这么说，刚才的纠结都值了。」', narration: '{actor}脸颊泛起一抹浅红，手指轻轻绞着衣角。' },
          { label: '比平时多了几分让人心动的味道', reply: '「什、什么叫让人心动啊……笨蛋，明明是你先让人心跳乱掉的。」', narration: '{actor}小声嘀咕了一句，眼尾却藏不住笑意。' },
        ],
      },
      {
        narration: '{actor}凑近看你手里的海图，肩膀几乎贴着你的手臂。',
        text: '「离这么近看路线……嗯，好像有点太近了？可我不想退开，怎么办呢。」',
      },
      {
        narration: '海面泛起细碎金光，{actor}轻声唤了你的名字。',
        text: '「奇怪，最近明明没什么大事，可一想到待会儿能见到你，嘴角就会自己翘起来。」',
      },
    ],
    night: [
      {
        narration: '昏黄的夜灯拉近了两人之间的距离，{actor}的声音轻得像耳语。',
        text: '「夜里安静下来，就特别容易想起白天和你说的每一句话……{cmd}，你现在也在想我吗？」',
      },
      {
        narration: '{actor}双手捧着温热的杯子，指尖轻轻摩挲杯壁，目光柔和地落在你身上。',
        text: '「只有我们两个人的深夜指挥室……如果时间能走慢一点就好了。」',
      },
    ],
  },
  adoration: {
    day: [
      {
        narration: '{actor}自然地挽住你的手臂，把半边身子的重量轻轻靠了过来。',
        text: '「{cmd}，今天的公文能不能分我一半？我想早点忙完，然后光明正大地独占你一整个下午。」',
        choices: [
          { label: '好，下午去防波堤只有我们俩', reply: '「一言为定。到时候不许聊舰队调度，只许聊我哦。」', narration: '{actor}满意地蹭了蹭你的肩头，笑声柔软。' },
          { label: '现在就可以先抱一会儿再继续', reply: '「……真是拿你没办法。那就借你的怀抱充五分钟电，不许动哦。」', narration: '{actor}轻轻环住你的腰，呼吸温热而安稳。' },
        ],
      },
      {
        narration: '{actor}伸手替你抚平衣领的褶皱，指尖在锁骨旁多停了一秒。',
        text: '「这身{outfit}我只打算在你面前穿得这么随意。……因为我知道，你会一直看着我的，对吧？」',
      },
      {
        narration: '午后光线温柔，{actor}托着腮静静凝视着你。',
        text: '「喜欢上你以后，连出海远航都多了一个最清晰的坐标——只要往你的方向返航就够了。」',
      },
    ],
    night: [
      {
        narration: '暖暗的台灯下，{actor}轻轻握住你的手，十指慢慢扣紧。',
        text: '「夜深了，{cmd}。今晚别急着赶我回宿舍好不好……就让我在这儿多陪你一会儿。」',
      },
      {
        narration: '{actor}微微倾身靠近，发梢垂落肩头，带着淡淡海风与皂角的香气。',
        text: '「白天的港区属于所有人，但今晚的灯光、晚风，还有我，都只属于你。」',
      },
    ],
  },
  oath: {
    day: [
      {
        narration: '无名指上的誓约指环在晨光下微微一闪，{actor}笑着牵起你的手。',
        text: '「早安，我最亲爱的{cmd}。不管穿着{outfit}还是战装，能每天醒来第一眼见到你，就是最好的日常。」',
        choices: [
          { label: '轻吻她的指尖', reply: '「唔……一大早就这么犯规，那今晚我也要加倍讨回来哦。」', narration: '{actor}眼眸弯成温柔的月牙，反手将你的手指握紧。' },
          { label: '今天也一起慢慢走过吧', reply: '「嗯，无论平静的港湾还是未知的远海，我都会一直在你触手可及的地方。」', narration: '{actor}轻轻靠在你肩侧，神色笃定而幸福。' },
        ],
      },
      {
        narration: '{actor}把泡好的红茶放到你面前，顺势在你脸颊上轻轻点了一下。',
        text: '「盖章完毕。今天也要记得按时吃饭，不许仗着有我照顾就偷偷熬夜哦。」',
      },
      {
        narration: '{actor}轻轻摩挲着无名指上的誓约徽记，抬眸时满眼都是藏不住的温柔。',
        text: '「自从和你缔结誓约以后，每次出海都觉得心里特别踏实——因为我知道港湾里永远有一盏为我留着的灯。」',
      },
      {
        narration: '海风吹起{outfit}的衣角，{actor}自然地替你理了理领口，贴近耳畔轻声道。',
        text: '「今天的出征补给和航线我都悄悄核对好啦，省下来的时间……全部留给我们两个人的约会，好不好？」',
      },
    ],
    night: [
      {
        narration: '夜灯微醺，{actor}依偎在你身侧，声音柔得像海面轻涌的潮汐。',
        text: '「{cmd}，关掉那些吵闹的电报机吧。今晚的时间，全部留给我们俩慢慢虚度好不好？」',
      },
      {
        narration: '{actor}轻轻把额头抵在你肩窝，发出一声满足的轻叹。',
        text: '「有你在身边，连最深的夜海都不会觉得冷。晚安……我的指挥官，我的唯一。」',
      },
      {
        narration: '窗外星河倒映在港湾水面，{actor}十指与你紧扣，誓约指环轻轻相碰。',
        text: '「深夜值班太累的话，就靠在我怀里眯一会儿吧。今天换我来守着你入睡，{cmd}。」',
      },
    ],
  },
});

/**
 * Outfit-specific subtle dialogue flavor lines when wearing custom/shop outfits.
 */
export const OUTFIT_FLAVOR_LINES = Object.freeze({
  水手服: {
    narration: '{actor}轻轻扯了扯蓝白相间的水手领结，转了个半圈。',
    text: '「这身水手服穿上居然一点也不违和呢……{cmd}，有没有一点校园海风的感觉？」',
  },
  丝质睡裙: {
    narration: '轻柔的丝质裙摆在暖灯下泛着微光，{actor}抱起双臂略显羞赧地靠在桌边。',
    text: '「这件丝质睡裙这么薄……也只有在你房间里才敢穿啦。视线不许乱飘哦，{cmd}。」',
  },
  居家宽衬衫: {
    narration: '宽大的白衬衫衣袖盖过半截手背，{actor}把衣领往上提了提，嘴角带着慵懒的笑。',
    text: '「借你的宽衬衫当居家服居然意外地舒服……上面好像还有一点你的味道呢。」',
  },
  针织毛衣: {
    narration: '{actor}把双手缩进软绵绵的针织毛衣袖口里，朝你凑近了一点。',
    text: '「毛衣暖烘烘的，海风吹进来也不怕冷啦。{cmd}要是手凉的话，可以借你暖一暖哦。」',
  },
  晚礼服: {
    narration: '星辉般的长裙勾勒出优雅轮廓，{actor}提着裙角微微屈膝，眼神亮得惊人。',
    text: '「换上这身晚礼服，是不是该由{cmd}亲自挽着我，跳完港湾今夜的第一支舞？」',
  },
});

/**
 * Portrait touch-zone reactions: head (头部) / shoulder (肩部·上身) / hand (手部).
 * Dedicated `oath` pool activates once the shipgirl has completed the Oath Ceremony!
 */
export const PORTRAIT_TOUCH_LINES = Object.freeze({
  head: {
    low: [
      { narration: '你轻轻碰了碰{actor}的发顶，她微微一怔，下意识往后仰了半寸。', text: '「诶、{cmd}？突然摸头的话，发型会乱掉的……」' },
      { narration: '{actor}抬眼看你，表情虽仍克制，耳朵却微微泛热。', text: '「虽然有点突然……不过，如果这是嘉奖的话，我就收下了。」' },
    ],
    mid: [
      { narration: '你的手掌落在{actor}发间，她顺从地微微低头，发丝柔软。', text: '「唔……手法怎么越来越熟练了啊，再揉下去我都要犯困了。」' },
      { narration: '{actor}眯起眼睛，像被顺毛的小猫一样轻轻晃了晃脑袋。', text: '「嗯……被{cmd}这样摸头，感觉一整天的疲惫都散掉了一半。」' },
    ],
    high: [
      { narration: '{actor}主动把脑袋往你掌心蹭了蹭，眼底漾开温柔的笑意。', text: '「再多摸一会儿也没关系哦。……只有你的手，让我怎么都躲不开。」' },
      { narration: '指尖穿过温软的发丝，{actor}轻声叹了口气，眉眼彻底舒展。', text: '「好喜欢你掌心的温度……{cmd}，别这么快收回去呀。」' },
    ],
    oath: [
      { narration: '{actor}闭上眼安心地把脸颊贴近你掌心，无名指上的誓约指环在灯下闪烁。', text: '「只有缔结过誓约的{cmd}，才可以随时这样宠我哦……今天也要多摸摸我呀。」' },
      { narration: '你轻抚过她的发顶，{actor}仰起脸朝你露出毫无防备的甜笑。', text: '「嗯……被你这样顺着头发，觉得自己被全世界最温柔的人好好珍藏着呢。」' },
    ],
  },
  shoulder: {
    low: [
      { narration: '你轻拍了拍{actor}的肩头，她立刻挺直了背脊。', text: '「是！装备扣件我都检查过了，没有松动。……诶，只是打招呼吗？」' },
      { narration: '{actor}顺着你的动作整理了一下{outfit}的肩线，神情认真。', text: '「谢谢关心，{cmd}，我目前体能状态良好。」' },
    ],
    mid: [
      { narration: '指尖轻触{actor}的肩头，她偏过头朝你弯了弯嘴角。', text: '「刚才肩膀确实有点酸呢，{cmd}要不要顺便帮我按两下？」' },
      { narration: '{actor}顺势往你这边靠了半步，声音比平时轻柔。', text: '「这身{outfit}的面料很软吧？……不过别趁机捏我肩膀哦。」' },
    ],
    high: [
      { narration: '你轻轻揽住{actor}的肩，她没有躲闪，反而把脸颊轻贴过来。', text: '「嗯……被你这样圈在身旁，心跳一下子就加快了呢，{cmd}。」' },
      { narration: '{actor}侧过脸，温热的呼吸拂过你的耳畔，声音带着几分慵懒撒娇。', text: '「这么主动地靠过来……今晚是不打算放我走了吗？」' },
    ],
    oath: [
      { narration: '你从身侧轻拥住{actor}的肩膀，她顺势整个人倚进你怀里，声音柔得像融化的糖。', text: '「已经签下誓约了，{cmd}想抱多久都可以哦……其实我也早就想赖在你怀里了。」' },
      { narration: '{actor}偏头轻轻吻了吻你搭在她肩上的手背，笑意盈盈。', text: '「我的肩膀、后背，还有以后漫长的岁月，全都交给你靠着啦。」' },
    ],
  },
  hand: {
    low: [
      { narration: '你的手指轻轻碰到{actor}的手背，她微微一颤，礼貌地收拢指节。', text: '「{cmd}，我的手刚沾过海风有点凉，别冻着您了。」' },
      { narration: '{actor}低头看了看两人短暂相触的手，轻声开口。', text: '「有什么文件要递给我吗？……啊，是我会错意了。」' },
    ],
    mid: [
      { narration: '你握住{actor}的手，她的指尖轻轻回勾了一下，唇角上扬。', text: '「手心好暖啊……下次散步的时候，也可以像这样牵一会儿吗？」' },
      { narration: '{actor}没有抽回手，只是红着脸把手指并拢放进你掌心。', text: '「……真是的，突然牵手的话，我都不知道眼睛该往哪儿看了。」' },
    ],
    high: [
      { narration: '{actor}主动与你十指相扣，轻轻晃了晃两人交握的手。', text: '「牵紧了哦，{cmd}。不管去哪片海域，这只手我都不打算松开了。」' },
      { narration: '{actor}把你的手贴在自己温热的脸颊边，眼眸里满是依恋。', text: '「你的温度让人好安心……今晚就这样握着我的手说话吧。」' },
    ],
    oath: [
      { narration: '你握住{actor}佩戴誓约指环的左手，指腹轻轻摩挲过微凉的戒圈，她耳尖瞬间染上暖绯。', text: '「这枚指环戴上以后，我就再也不打算摘下来了。{cmd}，牵好我，一辈子都不许松手哦。」' },
      { narration: '{actor}将两人十指紧扣的手举到灯下端详，眼里映出细碎星光。', text: '「无论多远的海域，只要想起你握住我手时的温度，就什么风浪都不怕了。」' },
    ],
  },
});

/**
 * 5 Slow-Paced Affinity Stage Breakthrough Mini-Theatres (gates: 20 / 40 / 60 / 80 / 100).
 * Played directly inside the bubble chat window!
 */
export const BREAKTHROUGH_THEATRES = Object.freeze({
  20: {
    gate: 20,
    fromLabel: '陌生',
    toLabel: '熟悉',
    title: '阶段突破 · 防波堤的初识茶歇',
    introNarration: '傍晚的港湾风浪渐歇，{actor}手里拎着两罐温热的红茶，在指挥室门口停下了脚步。',
    openingLine: '「{cmd}，看你忙了一整天……我顺路多买了一罐茶。要不，一起去阳台吹吹风？」',
    choices: [
      {
        id: 'bt20_a',
        label: '接过热茶：「正好想找你聊会儿天」',
        narration: '{actor}松了口气般笑起来，靠在栏杆上眺望橘红色的海面。',
        reply: '「其实刚来港区那会儿，我一直怕自己太拘谨惹人讨厌。现在发现，跟你待在一起意外地很轻松呢。」',
        closingNarration: '海风吹散了最后的客套与拘谨，你们之间正式跨入了【熟悉】阶段。',
      },
      {
        id: 'bt20_b',
        label: '笑着打趣：「看来你已经摸清我的作息了」',
        narration: '{actor}轻哼了一声，把温热的茶罐贴到你手背上。',
        reply: '「那是当然，谁让你每天这个点都在发呆看海图呢。以后可别再把自己当外人使唤我了哦。」',
        closingNarration: '轻松的玩笑拉近了彼此的距离，你们之间正式跨入了【熟悉】阶段。',
      },
    ],
  },
  40: {
    gate: 40,
    fromLabel: '熟悉',
    toLabel: '信赖',
    title: '阶段突破 · 雨夜灯塔下的托付',
    introNarration: '一场急雨敲打着港区玻璃窗，刚结束巡航整备的{actor}抖落发梢的水珠，把一份手绘海流笔记放到你面前。',
    openingLine: '「{cmd}，这是我这几周出海记下的暗礁和风向。……除了你，我没给别人看过。」',
    choices: [
      {
        id: 'bt40_a',
        label: '郑重收下：「这份心意和后背，我都接住了」',
        narration: '{actor}眸光微微发亮，整个人像是卸下了某种防备，向前迈了半步。',
        reply: '「嗯！以后不管遇到多难缠的深海编队，只要听到你的指令，我就敢往前冲。」',
        closingNarration: '无需多言的默契悄然生根，你们之间正式跨入了【信赖】阶段。',
      },
      {
        id: 'bt40_b',
        label: '递过干毛巾：「先擦擦头发，别着凉了」',
        narration: '{actor}接过毛巾捂住半边脸，闷闷地笑了一声，语气格外柔软。',
        reply: '「明明是我来给你送资料的，怎么反倒被你照顾了……不过，能把弱点放心交给你，真的很好。」',
        closingNarration: '雨声温柔，彼此的信赖彻底稳固，你们之间正式跨入了【信赖】阶段。',
      },
    ],
  },
  60: {
    gate: 60,
    fromLabel: '信赖',
    toLabel: '心动',
    title: '阶段突破 · 晚霞映照的心跳间隙',
    introNarration: '港湾栈桥被晚霞染成琥珀色，{actor}并肩走在你身侧，两人的影子在木板上越靠越近。',
    openingLine: '「{cmd}……我最近发现一件有点困扰的事。以前只是觉得跟你搭档很安心，可现在你稍微靠近一点，我心跳就会漏掉半拍。」',
    choices: [
      {
        id: 'bt60_a',
        label: '轻轻牵住她的手：「其实我也是」',
        narration: '{actor}指尖微微一缩，随即红着耳根反握住你，目光闪烁却没有逃开。',
        reply: '「笨蛋……说这种话之前也不提前打个招呼。那以后，就别装作没看见我的小心思了哦。」',
        closingNarration: '藏不住的悸动在晚风中挑明，你们之间正式跨入了【心动】阶段。',
      },
      {
        id: 'bt60_b',
        label: '温柔凝视她：「那我以后可以走得更近一点吗？」',
        narration: '{actor}脸颊染上比晚霞更暖的绯色，轻轻点了点头。',
        reply: '「……嗯。只要是你，再近一点也没关系。甚至……我其实一直在等你这么问。」',
        closingNarration: '细碎的心动有了回应，你们之间正式跨入了【心动】阶段。',
      },
    ],
  },
  80: {
    gate: 80,
    fromLabel: '心动',
    toLabel: '恋慕',
    title: '阶段突破 · 夜灯微醺的私语时刻',
    introNarration: '深夜指挥室的台灯散发着琥珀色暖光，窗外潮声轻缓。{actor}坐在你身旁，手指轻轻勾住你的衣袖。',
    openingLine: '「{cmd}，白天大家都喊你指挥官，可在只有我们两个人的夜里……我只想自私地把你留在我身边。」',
    choices: [
      {
        id: 'bt80_a',
        label: '将她轻轻拥入怀中：「今晚我只属于你」',
        narration: '{actor}发出一声轻柔的叹息，把额头靠在你胸口，双手慢慢环紧你的背。',
        reply: '「听到你的心跳声了……原来你也和我一样紧张呀。{cmd}，我已经越来越离不开你了。」',
        closingNarration: '灯影温柔摇曳，毫不掩饰的爱意在静夜里交融，你们之间正式跨入了【恋慕】阶段。',
      },
      {
        id: 'bt80_b',
        label: '轻抚她的脸颊：「我也一直在等你这句话」',
        narration: '{actor}偏头轻轻贴在你的掌心，眼尾染着淡淡绯红，笑意醉人。',
        reply: '「那可不许反悔。从今往后，无论白天还是深夜，你眼里最特别的那个人都只能是我。」',
        closingNarration: '彼此的心意再无保留，你们之间正式跨入了【恋慕】阶段。',
      },
    ],
  },
  100: {
    gate: 100,
    fromLabel: '恋慕',
    toLabel: '誓约',
    title: '阶段突破 · 星海之下的永恒约定',
    introNarration: '繁星倒映在平静如镜的港湾海面，{actor}换上最珍视的衣裳，静静站在灯塔露台等你走近。',
    openingLine: '「{cmd}，从陌生到熟悉，再到如今的每一个朝夕……如果未来的每一段航程都由我陪你走完，你愿意答应我吗？」',
    choices: [
      {
        id: 'bt100_a',
        label: '握紧她的双手：「今后所有的航程，我都只与你同行」',
        narration: '{actor}眼眶微微湿润，笑着扑进你怀里，海风将两人的誓言轻轻卷向星海。',
        reply: '「太好了……那我就正式成为你的专属誓约伴侣了。无论风浪多大，我永远在你身边。」',
        closingNarration: '★ 羁绊圆满升华！好感上限突破并解锁【誓约】阶段与誓约仪式。',
      },
      {
        id: 'bt100_b',
        label: '替她理好发丝：「欢迎回家，我最珍视的人」',
        narration: '{actor}垫起脚尖在你唇角轻啄一下，笑容灿烂得胜过整片星空。',
        reply: '「嗯，我回来了——我的指挥官，以后请多指教，一辈子哦。」',
        closingNarration: '★ 恋慕阶段圆满突破！现在可以正式点击「💍 发起誓约」举行誓约仪式了。',
      },
    ],
  },
});

/**
 * Romantic Oath Ceremony Mini-Theatre played inside the bubble chat window
 * when clicking 「💍 发起誓约」 after reaching affinity 100 & completing the 100 breakthrough!
 */
export const OATH_RITUAL_THEATRE = Object.freeze({
  title: '誓约仪式 · 碧海晴空下的永恒契约',
  introNarration: '海风吹拂着港湾纯白礼堂的纱幔，远方钟声悠然响起。身着{outfit}的{actor}手捧海风铃花束，眼眸闪耀着温柔而坚定的微光走到你面前。',
  openingLine: '「{cmd}……从初次在船坞相遇，到并肩驶过无数风暴，你一直是我最想守护的港湾。今天，你愿意将这枚誓约之戒交给我，与我缔结一生的羁绊吗？」',
  choices: [
    {
      id: 'oath_vow_a',
      label: '💍 为她戴上誓约指环：「无论晴空还是风浪，余生皆与你同行」',
      oathTitle: '永恒誓约',
      narration: '你郑重执起{actor}的左手，将泛着海蓝微光的誓约指环缓缓推入她的无名指。她指尖轻颤，眼底泛起喜悦的泪光。',
      reply: '「太好了……这枚指环的温度，我会记一辈子。从今往后，我不再只是你的舰娘——我是只属于你的誓约伴侣，{cmd}。」',
      closingNarration: '钟声与海鸥振翅声交织回荡，港湾见证了你们永恒的誓约！永久激活「誓约羁绊」（好感上限解放至 150 · 基础六维各 +4 · 出征油弹 -10% · 宿舍心情加速恢复）。',
    },
    {
      id: 'oath_vow_b',
      label: '💍 轻吻指环并拥她入怀：「欢迎来到我身边，我最珍视的唯一」',
      oathTitle: '星海誓约',
      narration: '银白色的指环在阳光下折射出清澈光芒，{actor}笑着扑进你的怀抱，海风将两人的誓言轻轻洒向整片港湾。',
      reply: '「嗯！无论未来的航图延伸到多远的深海，只要回头能看见你，我就能永远全力以赴。我爱你，我的指挥官。」',
      closingNarration: '海风温柔见证，誓约契约正式生效！永久激活「誓约羁绊」（好感上限解放至 150 · 基础六维各 +4 · 出征油弹 -10% · 宿舍心情加速恢复）。',
    },
  ],
});

/**
 * Fresh, breezy & subtly romantic maritime encounter short stories for Sortie Stage 3 chart nodes.
 * Automatically yielded to external imported JSON packs whenever present.
 */
export const MARITIME_ENCOUNTER_STORIES = Object.freeze([
  {
    id: 'sea_enc_sunset_buoy',
    title: '海面奇遇 · 橘色晚霞与漂流玻璃瓶',
    speaker: '{actor}',
    body: '海面忽然放晴，夕阳把浪尖镀成暖金色。{actor}从船舷边捞起一只裹着海藻的旧玻璃瓶，笑着凑到你耳边：「里面好像塞着一张手绘补给藏宝图，不过风好大，{cmd}帮我按住纸角好不好？」',
    choices: [
      {
        id: 'se_buoy_a',
        label: '扶住她的手腕一起辨认坐标（侦查检索）',
        statKey: 'recon',
        dc: 10,
        successText: '两人指尖相触间迅速核对了海流标记，顺着漂流带轻松打捞起一批完好的军需箱！{actor}红着耳根小声说：「跟你一起找东西运气真好。」',
        failText: '字迹被海水晕开了一半，但你们还是借着晚霞在浅礁边找到了几箱可用补给。',
        reward: { fuel: 35, ammo: 30, silver: 120 },
        affinity: 2,
        morale: 10,
      },
      {
        id: 'se_buoy_b',
        label: '顺势替她拢好被海风吹乱的发丝，稍作休整',
        statKey: null,
        dc: 0,
        successText: '{actor}微微一怔，随后弯起眉眼往你身侧靠了靠。短暂的静谧海风让全队紧绷的神经都舒缓下来。',
        reward: { fuel: 20, silver: 70 },
        affinity: 3,
        morale: 14,
      },
    ],
  },
  {
    id: 'sea_enc_starlight_mist',
    title: '海面奇遇 · 荧光海浪与甲板低语',
    speaker: '{actor}',
    body: '舰队驶入一片泛着淡蓝色夜光藻的平静海带，船尾拖出两道银河般的光痕。{actor}轻声拉住你的袖口：「难得没有敌情警报……{cmd}，陪我在舰桥多看两分钟好不好？」',
    choices: [
      {
        id: 'se_mist_a',
        label: '并肩倚在栏杆旁，把披风分她一半',
        statKey: null,
        dc: 0,
        successText: '{actor}顺从地钻进披风一侧，轻声哼着港区的旧谣。荧光海浪映亮她的眼眸，全舰队士气与默契悄然升温。',
        reward: { bauxite: 45, silver: 110 },
        affinity: 3,
        morale: 15,
      },
      {
        id: 'se_mist_b',
        label: '顺便开启声呐扫描海床微光（反潜侦测）',
        statKey: 'asw',
        dc: 11,
        successText: '声呐精准定位到沉没补给艇的浮标，打捞组满载钢材与铝材归来，{actor}笑着向你比了个胜利手势。',
        failText: '海底礁石干扰了回波，但沿途仍顺手回收了漂浮的应急资材。',
        reward: { steel: 65, bauxite: 40, silver: 95 },
        affinity: 2,
        morale: 8,
      },
    ],
  },
  {
    id: 'sea_enc_merchant_tea',
    title: '海面奇遇 · 友好商船的谢礼茶包',
    speaker: '{actor}',
    body: '一艘刚刚避开风暴的民用商船向舰队发出灯光致意，并用吊篮送来一盒还带着暖气的港湾红茶与新鲜点心。{actor}挑出最精致的一块递到你唇边：「{cmd}，张嘴，这是护航指挥官的专属慰劳。」',
    choices: [
      {
        id: 'se_tea_a',
        label: '笑着咬下一半，把另一半分给她',
        statKey: null,
        dc: 0,
        successText: '{actor}愣了半秒，脸颊微红却还是乖乖吃下了剩下那半块点心，整个舰桥瞬间充满甜丝丝的轻松氛围。',
        reward: { fuel: 30, ammo: 25, silver: 130 },
        affinity: 3,
        morale: 14,
      },
      {
        id: 'se_tea_b',
        label: '回赠航道气象情报并清点商船谢礼',
        statKey: 'recon',
        dc: 10,
        successText: '商船船长感激不已，额外赠送了一批高纯度油弹与银条补给，全队干劲倍增！',
        failText: '虽只交换了基础航线图，商船仍热情留下了补给箱致谢。',
        reward: { fuel: 45, ammo: 40, steel: 40, silver: 150 },
        affinity: 2,
        morale: 10,
      },
    ],
  },
]);

// ============================================================
// v32: Favorite Gifts, Battle MVP Return Bubbles, Retrofit Lines & Live Status Signature
// ============================================================

export const SHIP_FAVORITE_GIFTS_BY_CLASS = Object.freeze({
  DD: ['item_gift_dessert_box', 'item_gift_aroma_candle'],
  CL: ['item_gift_black_tea', 'item_gift_dessert_box'],
  CA: ['item_gift_pocket_watch', 'item_gift_black_tea'],
  BB: ['item_gift_tactical_journal', 'item_gift_pocket_watch'],
  CV: ['item_gift_aroma_candle', 'item_gift_black_tea'],
  SS: ['item_gift_aroma_candle', 'item_gift_dessert_box'],
  AR: ['item_gift_pocket_watch', 'item_gift_tactical_journal'],
  AO: ['item_gift_dessert_box', 'item_gift_black_tea'],
});

export const GIFT_NAME_BY_ID = Object.freeze({
  item_gift_dessert_box: '港区甜点盒',
  item_gift_black_tea: '伯爵红茶礼罐',
  item_gift_aroma_candle: '海风香薰蜡烛',
  item_gift_pocket_watch: '精工机械怀表',
  item_gift_tactical_journal: '精装战术手札',
});

export function getFavoriteGiftIdsForShip(actor) {
  const st = String(actor?.meta?.shipType || '');
  let cls = 'DD';
  if (/轻巡|CL/i.test(st)) cls = 'CL';
  else if (/重巡|CA/i.test(st)) cls = 'CA';
  else if (/战列|BB/i.test(st)) cls = 'BB';
  else if (/航母|CV/i.test(st)) cls = 'CV';
  else if (/潜艇|SS/i.test(st)) cls = 'SS';
  else if (/维修|AR/i.test(st)) cls = 'AR';
  else if (/补给|AO/i.test(st)) cls = 'AO';

  const base = [...(SHIP_FAVORITE_GIFTS_BY_CLASS[cls] || SHIP_FAVORITE_GIFTS_BY_CLASS.DD)];
  const pText = `${actor?.meta?.personalityCombo?.primaryName || ''} ${actor?.meta?.personality || ''}`;
  if (/傲娇|元气|吃货|活泼/.test(pText) && !base.includes('item_gift_dessert_box')) {
    base[1] = 'item_gift_dessert_box';
  } else if (/冷静|知性|严谨|腹黑/.test(pText) && !base.includes('item_gift_tactical_journal')) {
    base[1] = 'item_gift_tactical_journal';
  } else if (/温柔|体贴|文艺|慵懒/.test(pText) && !base.includes('item_gift_aroma_candle')) {
    base[1] = 'item_gift_aroma_candle';
  }
  return base.slice(0, 2);
}

export const FAVORITE_GIFT_REACTIONS = Object.freeze([
  {
    narration: '{actor}拆开包装的瞬间眼睛一下亮了起来，耳尖微微泛红，小心翼翼地把{gift}捧在胸口。',
    text: '「诶、诶？！你怎么知道我最想要{gift}的……{cmd}偷偷记下我的喜好，也太犯规了吧！」',
  },
  {
    narration: '{actor}愣了半秒才反应过来，嘴角怎么都压不住上扬的弧度，轻轻拉了拉你的衣袖。',
    text: '「居然真的是我最喜欢的{gift}……谢谢你，{cmd}！这份心意我会当成宝物好好珍藏起来的。」',
  },
  {
    narration: '柔和的惊喜在{actor}眼底晕开，她朝你凑近半步，声音里藏不住雀跃与害羞。',
    text: '「每次都在我最想要的时候送来{gift}……{cmd}这么了解我，我会越来越离不开你的呀。」',
  },
]);

export const MVP_RETURN_LINES = Object.freeze([
  {
    narration: '刚踏上港区栈桥，身上还带着淡淡硝烟味的{actor}便小跑着迎上来，眼睛亮晶晶地看着你。',
    text: '「{cmd}！刚才那场战斗的 MVP 是我哦！我的表现没有让你失望吧？下次出征也请继续把重任交给我！」',
  },
  {
    narration: '{actor}轻轻拭去额角海风带来的水汽，嘴角扬起骄傲又温柔的笑意。',
    text: '「顺利凯旋啦，{cmd}～今天能拿到全队 MVP，全靠你在后方的精准调度。……作为嘉奖，今晚可以多陪我聊一会儿吗？」',
  },
  {
    narration: '夕光洒在刚归港的{actor}肩头，她朝你俏皮地敬了个礼，语气轻快而自豪。',
    text: '「报告{cmd}，本次作战最佳表现奖已收入囊中！不过比起勋章，我更想听你亲口夸我一句呢。」',
  },
]);

export const RETROFIT_DIALOGUE_LINES = Object.freeze({
  1: {
    narration: '船坞龙门吊缓缓升起，完成「一阶段近代化改造」的{actor}迈着轻盈而沉稳的步伐走到你面前，舾装泛着崭新冷光。',
    text: '「{cmd}，一阶段近代化改造整备完毕！感觉火力与航速都脱胎换骨了——全新的我，请随时下令出击吧！」',
  },
  2: {
    narration: '海风吹拂着焕然一新的旗舰礼装与尖端舾装，完成「二阶段近代化改造 · 改二」的{actor}向你郑重敬礼，目光耀眼如星辰。',
    text: '「这就是我的最终形态「改二」……谢谢你一路倾注的心血，{cmd}。从今以后，无论多深的海域，我都能为你劈开前路！」',
  },
});

export function composeLiveStatusSignature({ actor, status, recentEvent = null, date = new Date() } = {}) {
  const tod = getTimeOfDayBucket(date);
  const morale = Math.round(Number(actor?.stats?.morale ?? 75));
  const retrofitStage = Math.floor(Number(actor?.meta?.retrofitStage || 0));
  const now = date.getTime();
  const isFresh = recentEvent && now - (Number(recentEvent.at) || 0) < 1000 * 60 * 45;

  if (isFresh && recentEvent.type === 'mvp') {
    return '🏆 刚刚斩获出征 MVP 凯旋归港，正期待着指挥官的嘉奖～';
  }
  if (isFresh && recentEvent.type === 'repaired') {
    return '🔧 刚从船坞满血出渠，船体焕然一新、心情超好！';
  }
  if (isFresh && recentEvent.type === 'retrofit') {
    return `⚙️ 刚刚完成${retrofitStage >= 2 ? '「改二」' : '「一改」'}近代化改造，迫不及待想试航！`;
  }
  if (morale < 35) {
    return '💤 有点疲惫，想要在宿舍里喝杯热茶好好休息一下…';
  }
  if (status?.isOathed) {
    return tod === 'night'
      ? '💍 深夜港湾静悄悄的，正戴着誓约指环等你一起看星星。'
      : '💍 誓约羁绊相伴左右，今天也是想和指挥官黏在一起的一天～';
  }
  if (morale >= 85) {
    return tod === 'night'
      ? '🌙 夜风轻柔、士气满满，随时可以陪你夜谈或夜战巡航！'
      : '☀️ 今日状态绝佳！甲板整备完毕，随时听候指挥官差遣～';
  }
  return tod === 'night'
    ? '🏮 深夜值守中，指挥室的暖灯还亮着呢，记得早点休息。'
    : '⚓ 正在港区码头吹海风，顺手核对今天的补给与海图清单。';
}

