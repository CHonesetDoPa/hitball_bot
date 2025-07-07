// 测试用户信息同步功能
require('dotenv').config();

// 模拟测试数据
const testUsers = [
    {
        id: 123456789,
        username: 'testuser1',
        first_name: '测试用户1',
        last_name: null
    },
    {
        id: 987654321,
        username: 'testuser2', 
        first_name: '测试用户2',
        last_name: '姓氏'
    },
    {
        id: 555666777,
        username: null,
        first_name: '无用户名用户',
        last_name: null
    }
];

// 模拟getUserDisplayName函数
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

// 模拟数据管理器
class TestHitDataManager {
    constructor() {
        this.data = {
            hitData: {},
            bounceAchievements: {},
            lastUpdated: new Date().toISOString()
        };
    }

    async syncUserInfo(userId, displayName, username = null) {
        let needsSave = false;
        
        if (!this.data.hitData[userId]) {
            this.data.hitData[userId] = {
                name: displayName || `用户${userId}`,
                username: username,
                count: 0,
                firstHitDate: new Date().toISOString()
            };
            needsSave = true;
            console.log(`✅ 新用户信息已创建: ${displayName} (ID: ${userId})`);
        } else {
            // 更新显示名称
            if (displayName && this.data.hitData[userId].name !== displayName) {
                console.log(`📝 更新显示名称: ${this.data.hitData[userId].name} -> ${displayName}`);
                this.data.hitData[userId].name = displayName;
                needsSave = true;
            }
            
            // 更新用户名
            if (username && this.data.hitData[userId].username !== username) {
                console.log(`👤 更新用户名: ${this.data.hitData[userId].username || '无'} -> ${username}`);
                this.data.hitData[userId].username = username;
                needsSave = true;
            }
        }
        
        if (needsSave) {
            console.log(`💾 用户信息已同步: ${displayName} (ID: ${userId})`);
        } else {
            console.log(`✓ 用户信息无变化: ${displayName} (ID: ${userId})`);
        }
        
        return this.data.hitData[userId];
    }

    findUserIdByUsername(username) {
        const cleanUsername = username.toLowerCase().replace('@', '');
        for (const [userId, userData] of Object.entries(this.data.hitData)) {
            if (userData.username && userData.username.toLowerCase() === cleanUsername) {
                return userId;
            }
        }
        return null;
    }

    printData() {
        console.log('\n📊 当前数据状态:');
        console.log(JSON.stringify(this.data.hitData, null, 2));
    }
}

// 测试函数
async function testUserSync() {
    console.log('🚀 开始测试用户信息同步功能...\n');
    
    const dataManager = new TestHitDataManager();
    
    // 测试1: 新用户同步
    console.log('📋 测试1: 新用户信息同步');
    for (const user of testUsers) {
        const displayName = getUserDisplayName(user);
        await dataManager.syncUserInfo(
            user.id.toString(), 
            displayName, 
            user.username
        );
    }
    
    dataManager.printData();
    
    // 测试2: 用户信息更新
    console.log('\n📋 测试2: 用户信息更新');
    await dataManager.syncUserInfo('123456789', '@newusername', 'newusername');
    await dataManager.syncUserInfo('987654321', '新的显示名称', 'testuser2');
    
    dataManager.printData();
    
    // 测试3: 用户名查找
    console.log('\n📋 测试3: 通过用户名查找用户ID');
    const foundId1 = dataManager.findUserIdByUsername('newusername');
    const foundId2 = dataManager.findUserIdByUsername('testuser2');
    const foundId3 = dataManager.findUserIdByUsername('notexist');
    
    console.log(`查找 'newusername': ${foundId1}`);
    console.log(`查找 'testuser2': ${foundId2}`);
    console.log(`查找 'notexist': ${foundId3}`);
    
    // 测试4: 重复同步（应该无变化）
    console.log('\n📋 测试4: 重复同步相同信息');
    await dataManager.syncUserInfo('123456789', '@newusername', 'newusername');
    
    console.log('\n✅ 测试完成！');
}

// 运行测试
testUserSync().catch(console.error);
