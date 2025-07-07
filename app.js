require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs').promises;
const path = require('path');

// 检查必要的环境变量
if (!process.env.BOT_TOKEN) {
    console.error('❌ 错误: 未设置机器人Token');
    console.error('请复制 .env.example 为 .env 并填入您的机器人token');
    process.exit(1);
}

// 创建机器人实例
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const dataFilePath = path.join(__dirname, 'data.json');

// 数据管理类
class HitDataManager {
    constructor() {
        this.data = {
            hitData: {},
            bounceAchievements: {}, // 反击成就记录
            lastUpdated: new Date().toISOString()
        };
    }

    // 加载数据
    async loadData() {
        try {
            const fileContent = await fs.readFile(dataFilePath, 'utf8');
            this.data = JSON.parse(fileContent);
            console.log('✅ 数据文件加载成功');
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.log('📁 数据文件不存在，将创建新文件');
                await this.saveData();
            } else {
                console.error('❌ 加载数据文件时出错:', error);
            }
        }
    }

    // 保存数据
    async saveData() {
        try {
            this.data.lastUpdated = new Date().toISOString();
            await fs.writeFile(dataFilePath, JSON.stringify(this.data, null, 2), 'utf8');
        } catch (error) {
            console.error('❌ 保存数据文件时出错:', error);
        }
    }

    // 击打高玩用户
    async hitUser(username, displayName) {
        if (!this.data.hitData[username]) {
            this.data.hitData[username] = {
                name: displayName || username,
                count: 0
            };
        }
        
        this.data.hitData[username].count++;
        await this.saveData();
        return this.data.hitData[username].count;
    }

    // 获取用户高玩击打次数
    getUserHitCount(username) {
        return this.data.hitData[username]?.count || 0;
    }

    // 获取排行榜
    getLeaderboard(limit = 10) {
        const sortedUsers = Object.entries(this.data.hitData)
            .sort(([,a], [,b]) => b.count - a.count)
            .slice(0, limit);
        
        return sortedUsers;
    }

    // 记录反击成就
    async recordBounceAchievement(username, displayName) {
        if (!this.data.bounceAchievements) {
            this.data.bounceAchievements = {};
        }
        
        if (!this.data.bounceAchievements[username]) {
            this.data.bounceAchievements[username] = {
                name: displayName || username,
                hasBounceAchievement: true,
                firstBounceDate: new Date().toISOString()
            };
            await this.saveData();
            return true; // 首次反击
        }
        
        return false; // 已经有反击成就
    }

    // 检查用户是否有反击成就
    hasBounceAchievement(username) {
        return this.data.bounceAchievements?.[username]?.hasBounceAchievement || false;
    }
}

// 创建数据管理器实例
const dataManager = new HitDataManager();

// 速率限制管理器
class RateLimitManager {
    constructor() {
        this.userCooldowns = new Map(); // 存储用户冷却时间
        this.userViolations = new Map(); // 存储用户违规次数
        this.hitCooldown = parseInt(process.env.HIT_COOLDOWN) || 3000; // /hit 命令冷却时间 (默认3秒)
        this.commandCooldown = parseInt(process.env.COMMAND_COOLDOWN) || 1000; // 其他命令冷却时间 (默认1秒)
        this.maxViolations = parseInt(process.env.MAX_VIOLATIONS) || 5; // 最大违规次数 (默认5次)
        this.muteTime = parseInt(process.env.MUTE_TIME) || 300; // 禁言时间 (默认5分钟)
        this.violationResetTime = parseInt(process.env.VIOLATION_RESET_TIME) || 60000; // 违规计数重置时间 (默认1分钟)
    }

    // 检查用户是否在冷却期
    isOnCooldown(userId, commandType = 'command') {
        const cooldownTime = commandType === 'hit' ? this.hitCooldown : this.commandCooldown;
        const userKey = `${userId}_${commandType}`;
        
        if (!this.userCooldowns.has(userKey)) {
            return false;
        }

        const lastUse = this.userCooldowns.get(userKey);
        const timePassed = Date.now() - lastUse;
        
        return timePassed < cooldownTime;
    }

    // 获取剩余冷却时间
    getRemainingCooldown(userId, commandType = 'command') {
        const cooldownTime = commandType === 'hit' ? this.hitCooldown : this.commandCooldown;
        const userKey = `${userId}_${commandType}`;
        
        if (!this.userCooldowns.has(userKey)) {
            return 0;
        }

        const lastUse = this.userCooldowns.get(userKey);
        const timePassed = Date.now() - lastUse;
        const remaining = cooldownTime - timePassed;
        
        return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
    }

    // 设置用户冷却
    setCooldown(userId, commandType = 'command') {
        const userKey = `${userId}_${commandType}`;
        this.userCooldowns.set(userKey, Date.now());
        
        // 清理过期的冷却记录
        this.cleanupExpiredCooldowns();
    }

    // 清理过期的冷却记录
    cleanupExpiredCooldowns() {
        const now = Date.now();
        const maxCooldown = Math.max(this.hitCooldown, this.commandCooldown);
        
        for (const [key, timestamp] of this.userCooldowns.entries()) {
            if (now - timestamp > maxCooldown) {
                this.userCooldowns.delete(key);
            }
        }
    }

    // 记录用户违规
    recordViolation(userId) {
        const now = Date.now();
        
        if (!this.userViolations.has(userId)) {
            this.userViolations.set(userId, {
                count: 1,
                firstViolation: now,
                lastViolation: now
            });
            return 1;
        }

        const violation = this.userViolations.get(userId);
        
        // 如果距离第一次违规超过重置时间，重置计数
        if (now - violation.firstViolation > this.violationResetTime) {
            this.userViolations.set(userId, {
                count: 1,
                firstViolation: now,
                lastViolation: now
            });
            return 1;
        }

        violation.count++;
        violation.lastViolation = now;
        return violation.count;
    }

    // 获取用户违规次数
    getViolationCount(userId) {
        if (!this.userViolations.has(userId)) {
            return 0;
        }

        const violation = this.userViolations.get(userId);
        const now = Date.now();
        
        // 如果距离第一次违规超过重置时间，返回0
        if (now - violation.firstViolation > this.violationResetTime) {
            this.userViolations.delete(userId);
            return 0;
        }

        return violation.count;
    }

    // 重置用户违规记录
    resetViolations(userId) {
        this.userViolations.delete(userId);
    }
}

// 创建速率限制管理器实例
const rateLimitManager = new RateLimitManager();

// 工具函数
function escapeMarkdown(text) {
    return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}

function getUserDisplayName(user) {
    if (user.username) {
        return `@${user.username}`;
    } else if (user.first_name && user.last_name) {
        return `${user.first_name} ${user.last_name}`;
    } else if (user.first_name) {
        return user.first_name;
    } else {
        return `用户${user.id}`;
    }
}

// 通过用户名获取用户信息
async function getUserByUsername(username) {
    try {
        // 移除@符号
        const cleanUsername = username.replace('@', '');
        
        // 这里可以通过Telegram API获取用户信息，但需要用户先与机器人互动
        // 暂时返回基础信息，实际项目中可以维护一个用户数据库
        return {
            username: cleanUsername,
            display_name: `@${cleanUsername}`,
            exists: true // 假设用户存在，实际可以通过API验证
        };
    } catch (error) {
        console.error('获取用户信息时出错:', error);
        return null;
    }
}

// 解析击打高玩目标
async function parseHitTarget(message, commandText) {
    let target = null;
    let targetUsername = null;
    let targetDisplayName = null;

    // 方式1: 检查是否回复了某人的消息
    if (message.reply_to_message && message.reply_to_message.from) {
        const replyUser = message.reply_to_message.from;
        target = replyUser;
        targetUsername = replyUser.username ? `@${replyUser.username}` : `user_${replyUser.id}`;
        targetDisplayName = getUserDisplayName(replyUser);
        
        console.log(`🎯 通过回复消息选择目标: ${targetDisplayName}`);
        return { target, targetUsername, targetDisplayName };
    }

    // 方式2: 解析命令中的@用户名
    const atUserMatch = commandText.match(/@(\w+)/);
    if (atUserMatch) {
        const username = atUserMatch[1];
        const userInfo = await getUserByUsername(username);
        
        if (userInfo && userInfo.exists) {
            target = { 
                username: username, 
                id: 'unknown',
                first_name: userInfo.display_name 
            };
            targetUsername = `@${username}`;
            targetDisplayName = userInfo.display_name;
            
            console.log(`🎯 通过@用户名选择目标: ${targetDisplayName}`);
            return { target, targetUsername, targetDisplayName };
        } else {
            console.log(`❌ 用户 @${username} 不存在或无法获取信息`);
            return null;
        }
    }

    // 方式3: 检查是否是转发消息或包含用户信息的消息
    if (message.forward_from) {
        const forwardUser = message.forward_from;
        target = forwardUser;
        targetUsername = forwardUser.username ? `@${forwardUser.username}` : `user_${forwardUser.id}`;
        targetDisplayName = getUserDisplayName(forwardUser);
        
        console.log(`🎯 通过转发消息选择目标: ${targetDisplayName}`);
        return { target, targetUsername, targetDisplayName };
    }

    // 方式4: 检查消息中的text_mention实体
    if (message.entities) {
        for (const entity of message.entities) {
            if (entity.type === 'text_mention' && entity.user) {
                const mentionUser = entity.user;
                target = mentionUser;
                targetUsername = mentionUser.username ? `@${mentionUser.username}` : `user_${mentionUser.id}`;
                targetDisplayName = getUserDisplayName(mentionUser);
                
                console.log(`🎯 通过文本提及选择目标: ${targetDisplayName}`);
                return { target, targetUsername, targetDisplayName };
            }
        }
    }

    return null;
}

// 随机击打高玩消息
const hitMessages = [
    '💥 {attacker} 给了 {target} 一记高玩重击！',
    '🏏 {attacker} 用球拍狠狠击打了 {target} 的高玩！',
    '👊 {attacker} 对 {target} 的高玩发动了暴击！',
    '🎯 {attacker} 精准击中了 {target} 的高玩！',
    '⚡ {attacker} 闪电般击打了 {target} 的高玩！',
    '🔨 {attacker} 用大锤敲击了 {target} 的高玩！',
    '🥊 {attacker} 给 {target} 的高玩来了一拳！',
    '💢 {attacker} 怒击 {target} 的高玩！',
    '🌟 {attacker} 发动了华丽的连击！{target} 的高玩被击中了！',
    '💫 {attacker} 使出了必杀技！{target} 的高玩承受了巨大伤害！'
];

function getRandomHitMessage(attacker, target) {
    const message = hitMessages[Math.floor(Math.random() * hitMessages.length)];
    return message.replace('{attacker}', attacker).replace('{target}', target);
}

// 机器人事件处理
bot.on('error', (error) => {
    console.error('❌ 击打高玩机器人错误:', error);
});

bot.on('polling_error', (error) => {
    console.error('❌ 击打高玩轮询错误:', error);
});

// 启动命令
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    
    // 检查群聊限制
    if (!checkGroupCommandRestriction(msg, '/start')) {
        return;
    }
    
    // 检查速率限制
    if (!(await checkRateLimit(msg, 'command'))) {
        return;
    }
    
    const welcomeMessage = `
🎮 **欢迎使用击打高玩机器人！** 

一个有趣的群聊互动机器人！

**🚀 快速上手：**
• 回复某人消息 + \`/hit\` → 击打他们的高玩
• \`/hit @用户名\` → 击打指定用户的高玩
• \`/stats\` → 查看高玩受击统计
• \`/leaderboard\` → 查看高玩受击排行榜
• \`/achievements\` → 查看高玩受击成就

**✨ 特色功能：**
🎲 随机高玩击打效果 | 🏆 高玩受击排行榜 | 🎖️ 高玩成就解锁
📊 详细高玩受击统计 | 🎊 高玩里程碑庆祝 | 💾 数据永久保存

**⚡ 智能限制：**
• 速率限制防刷屏 | 🔒 群聊仅限击打命令 | 🛡️ 私聊无限制 | 🤖 机器人反弹保护

**💡 小贴士：**
• 群聊中只能使用 \`/hit\` 命令，其他功能请私聊机器人
• 击打有3秒冷却，其他命令有1秒冷却
• 在群组中使用效果更佳，快邀请朋友一起来击打高玩吧！

发送 \`/help\` 获取完整使用指南。

准备好开始了吗？💪🎯
    `;
    
    bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
});

// 帮助命令
bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    
    // 检查群聊限制
    if (!checkGroupCommandRestriction(msg, '/help')) {
        return;
    }
    
    // 检查速率限制
    if (!(await checkRateLimit(msg, 'command'))) {
        return;
    }
    
    const helpMessage = `
🆘 **击打高玩机器人完整指南**

**🎯 击打高玩命令：**
\`/hit\` - 击打回复消息中用户的高玩
\`/hit @用户名\` - 击打指定用户的高玩

**📊 统计命令：**
\`/stats\` - 查看自己的高玩受击统计
\`/stats @用户名\` - 查看指定用户高玩受击统计
\`/leaderboard\` - 查看高玩受击排行榜

**🏆 成就系统：**
\`/achievements\` - 查看自己的高玩成就
\`/achievements @用户名\` - 查看指定用户高玩受击成就

**ℹ️ 其他命令：**
\`/start\` - 开始使用机器人
\`/help\` - 显示此帮助信息

**⚡ 使用限制：**
• 击打命令冷却：3秒 (防止刷屏)
• 其他命令冷却：1秒 (防止频繁请求)
• 群聊限制：只能使用 \`/hit\` 命令，其他命令请私聊机器人
• 🛡️ 机器人保护：攻击机器人会被反弹，攻击者自己受到伤害

**🎯 击打高玩方式：**
1️⃣ **回复消息击打高玩：** 回复某人的消息，然后发送 \`/hit\`
2️⃣ **用户名击打高玩：** 发送 \`/hit @用户名\`
3️⃣ **转发击打高玩：** 转发某人的消息，然后发送 \`/hit\`

**✨ 特色功能：**
• 🎲 随机高玩击打效果消息
• 🏆 详细的高玩受击排行榜和统计
• 🎖️ 高玩成就解锁系统
• 📈 高玩受击进度条和百分比
• 🎊 特殊高玩里程碑庆祝

**💡 使用技巧：**
• 在群组中使用效果更佳
• 可以击打任何有用户名用户的高玩
• 高玩受击数据会永久保存
• 支持多种用户选择方式
• ⚠️ **注意：** 不要试图攻击机器人，所有攻击都会反弹到你自己身上！

开始你的高玩击打之旅吧！💪🎯
    `;
    
    bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

// 击打高玩命令
bot.onText(/\/hit(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const attacker = msg.from;
    const commandText = match[1] || ''; // 获取/hit后面的内容

    // 检查速率限制 (击打命令有更长的冷却时间)
    if (!(await checkRateLimit(msg, 'hit'))) {
        return;
    }

    try {
        // 解析击打高玩目标
        const targetInfo = await parseHitTarget(msg, commandText);
        
        if (!targetInfo) {
            const helpText = `❌ **没找到要击打高玩的目标！**

**请使用以下方式指定目标：**
1️⃣ 回复某人的消息，然后发送 \`/hit\`
2️⃣ 使用 \`/hit @用户名\`
3️⃣ 转发某人的消息，然后发送 \`/hit\`

**示例：**
\`/hit @username\` - 击打指定用户的高玩
\`/hit\` (回复消息时) - 击打被回复用户的高玩

找准目标再开火！🎯`;
            
            bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
            return;
        }

        const { target, targetUsername, targetDisplayName } = targetInfo;

        // 防止自己击打自己的高玩
        if (target.id === attacker.id || (target.username && target.username === attacker.username)) {
            const selfHitMessages = [
                '😅 别闹了，你不能击打自己的高玩！',
                '🤔 想要自虐高玩吗？这里不提供自我击打高玩服务哦！',
                '😄 自己打自己的高玩？建议去照镜子练习！',
                '🙃 emmm...要不你对着空气挥几拳击打高玩？',
                '😂 自己击打自己的高玩是什么新玩法？'
            ];
            const randomMessage = selfHitMessages[Math.floor(Math.random() * selfHitMessages.length)];
            bot.sendMessage(chatId, randomMessage);
            return;
        }

        // 检查是否试图攻击机器人并实现反弹
        const botInfo = await bot.getMe();
        if (target.id === botInfo.id || (target.username && target.username === botInfo.username)) {
            // 攻击反弹 - 攻击者成为被攻击目标
            const attackerUsername = attacker.username ? `@${attacker.username}` : `user_${attacker.id}`;
            const attackerDisplayName = getUserDisplayName(attacker);
            
            // 记录反击成就（如果是首次）
            const isFirstBounce = await dataManager.recordBounceAchievement(attackerUsername, attackerDisplayName);
            
            // 正常击打攻击者
            const hitCount = await dataManager.hitUser(attackerUsername, attackerDisplayName);
            
            const bounceMessages = [
                '🛡️ **攻击反弹！** 机器人启动了防护系统！',
                '⚡ **反击启动！** 你以为机器人那么好欺负？',
                '🔄 **攻击反弹！** 机器人的高玩受到了神圣保护！',
                '💫 **反弹伤害！** 机器人反击了你的攻击！',
                '🌀 **能量反射！** 你的攻击被完美反弹！'
            ];
            
            const randomBounceMessage = bounceMessages[Math.floor(Math.random() * bounceMessages.length)];
            
            // 根据是否首次反击添加特殊效果
            let specialEffect = '';
            if (isFirstBounce) {
                specialEffect = '\n🎊 **首次反弹攻击！** 你解锁了"机器人挑战者"成就！';
            } else if (hitCount % 10 === 0) {
                specialEffect = `\n🏆 **里程碑击打！** 这是第 ${hitCount} 次高玩击打！`;
            }

            const bounceMessage = `${randomBounceMessage}\n\n💥 ${attackerDisplayName} 试图攻击机器人，结果被反弹击中了自己的高玩！\n\n📊 ${attackerDisplayName} 的高玩已被击打 **${hitCount}** 次！${specialEffect}`;
            
            bot.sendMessage(chatId, bounceMessage, { parse_mode: 'Markdown' });
            
            console.log(`🛡️ ${attackerDisplayName} 试图攻击机器人，攻击被反弹 (第${hitCount}次击打${isFirstBounce ? '，首次反击' : ''})`);
            return;
        }

        // 记录击打高玩
        const attackerName = getUserDisplayName(attacker);
        const hitCount = await dataManager.hitUser(targetUsername, targetDisplayName);
        
        // 生成击打高玩消息
        const hitMessage = getRandomHitMessage(attackerName, targetDisplayName);
        
        // 根据高玩击打次数添加特殊效果
        let specialEffect = '';
        if (hitCount === 1) {
            specialEffect = '\n🎊 **首次高玩击打！** 新的高玩受害者诞生了！';
        } else if (hitCount % 10 === 0) {
            specialEffect = `\n🏆 **里程碑高玩击打！** 这是第 ${hitCount} 次高玩击打！`;
        } else if (hitCount === 50) {
            specialEffect = '\n💀 **半百高玩击打！** 这位的高玩已经被击打了50次了！';
        } else if (hitCount === 100) {
            specialEffect = '\n👑 **百击高玩之王！** 恭喜成为百击高玩俱乐部成员！';
        }

        const countMessage = `\n\n📊 ${targetDisplayName} 的高玩已被击打 **${hitCount}** 次！${specialEffect}`;
        
        bot.sendMessage(chatId, hitMessage + countMessage, { parse_mode: 'Markdown' });
        
        console.log(`🎯 ${attackerName} 击打了 ${targetDisplayName} 的高玩 (第${hitCount}次)`);
        
    } catch (error) {
        console.error('❌ 处理击打高玩命令时出错:', error);
        bot.sendMessage(chatId, '❌ 击打高玩失败，请稍后重试！可能是目标用户信息获取失败。');
    }
});

// 统计命令
bot.onText(/\/stats(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const commandText = match[1] || ''; // 获取/stats后面的内容
    let targetUsername = null;
    let targetDisplayName = null;

    // 检查群聊限制
    if (!checkGroupCommandRestriction(msg, '/stats')) {
        return;
    }
    
    // 检查速率限制
    if (!(await checkRateLimit(msg, 'command'))) {
        return;
    }

    try {
        // 检查是否指定了用户名
        const atUserMatch = commandText.match(/@(\w+)/);
        if (atUserMatch) {
            const username = atUserMatch[1];
            const userInfo = await getUserByUsername(username);
            
            if (userInfo && userInfo.exists) {
                targetUsername = `@${username}`;
                targetDisplayName = userInfo.display_name;
            } else {
                bot.sendMessage(chatId, `❌ 找不到用户 @${username} 的信息！`);
                return;
            }
        } 
        // 检查是否回复了某人的消息
        else if (msg.reply_to_message && msg.reply_to_message.from) {
            const replyUser = msg.reply_to_message.from;
            targetUsername = replyUser.username ? `@${replyUser.username}` : `user_${replyUser.id}`;
            targetDisplayName = getUserDisplayName(replyUser);
        }
        // 如果没有指定用户，显示发送者的统计
        else {
            const user = msg.from;
            targetUsername = user.username ? `@${user.username}` : `user_${user.id}`;
            targetDisplayName = getUserDisplayName(user);
        }

        const hitCount = dataManager.getUserHitCount(targetUsername);
        
        // 根据高玩击打次数生成不同的统计消息
        let statusEmoji = '';
        let statusText = '';
        
        if (hitCount === 0) {
            statusEmoji = '🍀';
            statusText = '高玩还没有被击打过，真是个幸运儿！';
        } else if (hitCount <= 5) {
            statusEmoji = '😊';
            statusText = '高玩轻微受伤，还能继续战斗！';
        } else if (hitCount <= 20) {
            statusEmoji = '😵';
            statusText = '高玩中度受创，需要休息一下！';
        } else if (hitCount <= 50) {
            statusEmoji = '🤕';
            statusText = '高玩重度创伤，已经是常客了！';
        } else if (hitCount <= 100) {
            statusEmoji = '💀';
            statusText = '骨灰级高玩受害者，可以申请保护了！';
        } else {
            statusEmoji = '👻';
            statusText = '传说级高玩存在，已经超越了生死！';
        }

        const statsMessage = `📊 **高玩击打统计报告**

👤 **目标：** ${escapeMarkdown(targetDisplayName)}
🎯 **高玩被击打次数：** **${hitCount}** 次
${statusEmoji} **状态：** ${statusText}

💡 使用 \`/leaderboard\` 查看高玩排行榜`;
        
        bot.sendMessage(chatId, statsMessage, { parse_mode: 'Markdown' });
        
    } catch (error) {
        console.error('❌ 处理高玩统计命令时出错:', error);
        bot.sendMessage(chatId, '❌ 获取高玩统计信息失败，请稍后重试！');
    }
});

// 排行榜命令
bot.onText(/\/leaderboard/, async (msg) => {
    const chatId = msg.chat.id;
    
    // 检查群聊限制
    if (!checkGroupCommandRestriction(msg, '/leaderboard')) {
        return;
    }
    
    // 检查速率限制
    if (!(await checkRateLimit(msg, 'command'))) {
        return;
    }
    
    try {
        const leaderboard = dataManager.getLeaderboard(10);
        
        if (leaderboard.length === 0) {
            const emptyMessage = `📊 **高玩受击排行榜**

🤷‍♂️ 还没有人的高玩被击打过！

**成为第一个高玩击打目标：**
• 回复某人的消息并发送 \`/hit\`
• 或使用 \`/hit @用户名\`

快来开启高玩击打传奇吧！🎯`;

            bot.sendMessage(chatId, emptyMessage, { parse_mode: 'Markdown' });
            return;
        }

        let message = '🏆 **高玩受击排行榜** 🏆\n\n';
        
        // 计算总高玩击打次数
        const totalHits = leaderboard.reduce((sum, [, data]) => sum + data.count, 0);
        
        leaderboard.forEach(([username, data], index) => {
            const rank = index + 1;
            let medal = '';
            let prefix = '';
            let rankText = '';
            
            // 设置排名图标
            switch (rank) {
                case 1:
                    medal = '🥇';
                    prefix = '👑 ';
                    rankText = ' - 高玩击打首选';
                    break;
                case 2:
                    medal = '🥈';
                    prefix = '⭐ ';
                    rankText = ' - 高玩二号目标';
                    break;
                case 3:
                    medal = '🥉';
                    prefix = '✨ ';
                    rankText = ' - 铜牌高玩受击王';
                    break;
                default:
                    medal = '🏅';
                    prefix = `${rank}\\. `;
                    rankText = ' - 高玩受击常客';
            }

            // 计算高玩击打百分比
            const percentage = ((data.count / totalHits) * 100).toFixed(1);
            
            // 生成进度条
            const barLength = 10;
            const filledLength = Math.round((data.count / leaderboard[0][1].count) * barLength);
            const progressBar = '█'.repeat(filledLength) + '▒'.repeat(barLength - filledLength);
            
            message += `${medal} ${prefix}${escapeMarkdown(data.name)}\n`;
            message += `   🎯 高玩被击打 **${data.count}** 次 (${percentage}%)${rankText}\n`;
            message += `   \`${progressBar}\`\n\n`;
        });

        // 添加统计摘要
        message += `📈 **统计摘要**\n`;
        message += `• 总高玩击打次数：**${totalHits}** 次\n`;
        message += `• 高玩受击用户人数：**${leaderboard.length}** 人\n`;
        message += `• 最后更新：${new Date().toLocaleString('zh-CN')}`;

        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        
    } catch (error) {
        console.error('❌ 处理高玩排行榜命令时出错:', error);
        bot.sendMessage(chatId, '❌ 获取高玩排行榜失败，请稍后重试！');
    }
});

// 个人高玩成就命令
bot.onText(/\/achievements(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const commandText = match[1] || '';
    let targetUsername = null;
    let targetDisplayName = null;

    // 检查群聊限制
    if (!checkGroupCommandRestriction(msg, '/achievements')) {
        return;
    }
    
    // 检查速率限制
    if (!(await checkRateLimit(msg, 'command'))) {
        return;
    }

    try {
        // 检查是否指定了用户名
        const atUserMatch = commandText.match(/@(\w+)/);
        if (atUserMatch) {
            const username = atUserMatch[1];
            const userInfo = await getUserByUsername(username);
            
            if (userInfo && userInfo.exists) {
                targetUsername = `@${username}`;
                targetDisplayName = userInfo.display_name;
            } else {
                bot.sendMessage(chatId, `❌ 找不到用户 @${username} 的信息！`);
                return;
            }
        } 
        // 检查是否回复了某人的消息
        else if (msg.reply_to_message && msg.reply_to_message.from) {
            const replyUser = msg.reply_to_message.from;
            targetUsername = replyUser.username ? `@${replyUser.username}` : `user_${replyUser.id}`;
            targetDisplayName = getUserDisplayName(replyUser);
        }
        // 如果没有指定用户，显示发送者的高玩成就
        else {
            const user = msg.from;
            targetUsername = user.username ? `@${user.username}` : `user_${user.id}`;
            targetDisplayName = getUserDisplayName(user);
        }

        const hitCount = dataManager.getUserHitCount(targetUsername);
        const leaderboard = dataManager.getLeaderboard(100);
        
        // 找到用户在高玩排行榜中的位置
        const userRank = leaderboard.findIndex(([username]) => username === targetUsername) + 1;
        
        // 计算高玩成就
        const achievements = [];
        
        if (hitCount >= 1) achievements.push('🎯 初次高玩受击 - 第一次高玩被击打');
        if (hitCount >= 5) achievements.push('😵 轻度高玩受伤 - 开始感受到高玩压力');
        if (hitCount >= 10) achievements.push('🤕 中度高玩打击 - 高玩受到了不小的冲击');
        if (hitCount >= 25) achievements.push('💀 重度高玩创伤 - 开始怀疑高玩人生');
        if (hitCount >= 50) achievements.push('👻 半百高玩俱乐部 - 高玩被击打50次的传说');
        if (hitCount >= 100) achievements.push('🏆 百击高玩传说 - 最受关注的高玩目标');
        if (hitCount >= 200) achievements.push('💎 钻石级高玩受害者 - 顶级高玩受击者');
        if (hitCount >= 500) achievements.push('👑 高玩克星之王 - 高玩被击打的恐惧');
        
        if (userRank === 1) achievements.push('🥇 高玩众矢之的 - 高玩受击排行榜第一');
        if (userRank === 2) achievements.push('🥈 高玩二号目标 - 高玩受击排行榜第二');
        if (userRank === 3) achievements.push('🥉 铜牌高玩受击王 - 高玩受击排行榜第三');
        if (userRank > 0 && userRank <= 10) achievements.push('🏅 高玩前十常客 - 进入高玩受击排行榜前10名');
        
        // 检查反击成就
        if (dataManager.hasBounceAchievement(targetUsername)) {
            achievements.push('🛡️ 机器人挑战者 - 试图攻击机器人但被反弹');
        }

        let message = `🏆 **高玩受击成就报告**\n\n`;
        message += `👤 **目标：** ${escapeMarkdown(targetDisplayName)}\n`;
        message += `🎯 **高玩被击打次数：** **${hitCount}** 次\n`;
        message += `📊 **高玩受击排行榜排名：** ${userRank > 0 ? `第 **${userRank}** 名` : '未上榜'}\n\n`;

        if (achievements.length > 0) {
            message += `🎖️ **已解锁高玩成就 (${achievements.length})：**\n`;
            achievements.forEach(achievement => {
                message += `${achievement}\n`;
            });
        } else {
            message += `🎖️ **高玩成就：** 暂无高玩成就，继续努力吧！`;
        }

        // 添加下一个高玩成就提示
        const nextMilestones = [1, 5, 10, 25, 50, 100, 200, 500, 1000];
        const nextMilestone = nextMilestones.find(milestone => milestone > hitCount);
        
        if (nextMilestone) {
            const remaining = nextMilestone - hitCount;
            message += `\n\n🎯 **下一个高玩成就：** 高玩还需被击打 **${remaining}** 次解锁新成就！`;
        }

        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        
    } catch (error) {
        console.error('❌ 处理高玩成就命令时出错:', error);
        bot.sendMessage(chatId, '❌ 获取高玩成就信息失败，请稍后重试！');
    }
});

// 检查是否为群聊
function isGroupChat(chatType) {
    return chatType === 'group' || chatType === 'supergroup';
}

// 群聊命令限制检查
function checkGroupCommandRestriction(msg, commandName) {
    if (isGroupChat(msg.chat.type) && commandName !== '/hit') {
        const botUsername = process.env.BOT_USERNAME || 'hitball_bot';
        const restrictedMessage = `🚫 **群聊限制**

为了保持群聊的简洁，在群聊中只能使用 \`/hit\` 命令。

**其他命令请私聊机器人使用：**
• \`/stats\` - 查看击打统计
• \`/leaderboard\` - 查看排行榜  
• \`/achievements\` - 查看成就
• \`/help\` - 获取帮助

💬 **开始私聊：** 点击 [@${botUsername}](https://t.me/${botUsername}) 或搜索机器人用户名！`;
        
        bot.sendMessage(msg.chat.id, restrictedMessage, { 
            parse_mode: 'Markdown',
            disable_web_page_preview: true 
        });
        return false;
    }
    return true;
}

// 速率限制检查
async function checkRateLimit(msg, commandType = 'command') {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    
    if (rateLimitManager.isOnCooldown(userId, commandType)) {
        // 记录违规并检查是否需要禁言
        const violationCount = rateLimitManager.recordViolation(userId);
        
        if (violationCount >= rateLimitManager.maxViolations) {
            // 达到最大违规次数，尝试禁言用户
            if (isGroupChat(msg.chat.type)) {
                try {
                    await bot.restrictChatMember(chatId, userId, {
                        until_date: Math.floor(Date.now() / 1000) + rateLimitManager.muteTime,
                        permissions: {
                            can_send_messages: false,
                            can_send_media_messages: false,
                            can_send_polls: false,
                            can_send_other_messages: false,
                            can_add_web_page_previews: false,
                            can_change_info: false,
                            can_invite_users: false,
                            can_pin_messages: false
                        }
                    });
                    
                    console.log(`🔇 用户 ${userId} 因连续违规 ${violationCount} 次被禁言 ${rateLimitManager.muteTime} 秒`);
                    
                    // 重置违规计数
                    rateLimitManager.resetViolations(userId);
                    
                } catch (error) {
                    console.error('❌ 禁言用户失败:', error);
                    // 如果禁言失败，可能是权限不足，继续执行但记录错误
                }
            }
        }
        
        return false;
    }
    
    rateLimitManager.setCooldown(userId, commandType);
    return true;
}

// 管理员命令 - 查看速率限制状态（调试用）
bot.onText(/\/ratelimit/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // 检查群聊限制
    if (!checkGroupCommandRestriction(msg, '/ratelimit')) {
        return;
    }
    
    const hitCooldown = rateLimitManager.getRemainingCooldown(userId, 'hit');
    const commandCooldown = rateLimitManager.getRemainingCooldown(userId, 'command');
    
    let message = `⏱️ **速率限制状态**\n\n`;
    message += `👤 **用户：** ${getUserDisplayName(msg.from)}\n\n`;
    
    if (hitCooldown > 0) {
        message += `🎯 **击打冷却：** ${hitCooldown} 秒\n`;
    } else {
        message += `🎯 **击打冷却：** ✅ 可用\n`;
    }
    
    if (commandCooldown > 0) {
        message += `⚙️ **命令冷却：** ${commandCooldown} 秒\n`;
    } else {
        message += `⚙️ **命令冷却：** ✅ 可用\n`;
    }
    
    message += `\n📊 **冷却时间设置：**\n`;
    message += `• 击打命令：${rateLimitManager.hitCooldown / 1000} 秒\n`;
    message += `• 其他命令：${rateLimitManager.commandCooldown / 1000} 秒`;
    
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

// 启动机器人
async function startBot() {
    console.log('🚀 正在启动击打高玩机器人...');
    
    try {
        // 加载数据
        await dataManager.loadData();
        
        // 获取机器人信息
        const botInfo = await bot.getMe();
        console.log(`✅ 击打高玩机器人启动成功！`);
        console.log(`🤖 机器人名称: ${botInfo.first_name}`);
        console.log(`👤 用户名: @${botInfo.username}`);
        console.log(`🆔 机器人ID: ${botInfo.id}`);
        console.log('📡 开始监听消息...');
        
    } catch (error) {
        console.error('❌ 启动击打高玩机器人时出错:', error);
        process.exit(1);
    }
}

// 优雅关闭
process.on('SIGINT', () => {
    console.log('\n🛑 正在关闭击打高玩机器人...');
    bot.stopPolling();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 正在关闭击打高玩机器人...');
    bot.stopPolling();
    process.exit(0);
});

// 启动击打高玩机器人
startBot();