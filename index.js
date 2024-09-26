const express = require('express');
const http = require('http');
const socketIo = require('socket.io'); //導入socket.io功能(即時傳遞訊息)

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
// 載入問題json檔
const QUESTIONS_1 = require('./data/questions1.json');
const QUESTIONS_2 = require('./data/questions2.json');
const QUESTIONS_3 = require('./data/questions3.json');

const gameRooms = {};
let timers = {}; 
const COUNTDOWN_START = 5;
const INTERIM_SCORE_DISPLAY_TIME = 5;
const SCORE_INCREMENT = 10;

// 初始化遊戲室與roomID
io.on('connection', (socket) => {
    socket.on('createRoom', (callback) => {
        let roomId;
        do { //padstart是補0滿6位數
          roomId = Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
        } while (gameRooms[roomId]); // 持續生成新的ID 直到不重複
        gameRooms[roomId] = {
            host: socket.id,
            QUESTIONS:{},
            QUESTIONS_NUM: 10,
            QUESTION_TIME_LIMIT: 10,
            participants: [],
            currentQuestionIndex: 0,
            scores: {},
            answers: {}
        };
        socket.join(roomId);
        callback(roomId); // Send back the unique room ID
        gameRooms[roomId].QUESTIONS = QUESTIONS_3; //預設鑑別度3(高)
    });
    // 收到participants端 使用者加入時的處理
    socket.on('joinRoom', (roomId, username, callback) => {
        const room = gameRooms[roomId];
        if (!room) {
            return callback({ success: false, message: "找不到房間，請房主重開吧！" });
        }
        if (room.participants.includes(username)) {
            return callback({ success: false, message: "這個名字已經有人用了喔！" });
        }
        handleJoinRoom(socket, roomId, username, callback)
    });
    // 監聽 disconnect 事件(當participant離開遊戲室的處理)
    socket.on('disconnect', () => {
        handleDisconnect(socket);
        console.log(`User disconnected: ${socket.id}`);
    });
    // 收到host 選擇鑑別度的處理
    socket.on('chooseLevel', (roomId, level) => {
        changeLevel(roomId, level);
    });
    // 收到host 選擇題目數的處理
    socket.on('chooseQuestionsNum', (roomId, qNum) => {
        changeQuestionsNum(roomId, qNum);
    });
    // 收到host 選擇答題時間的處理
    socket.on('chooseAnswerTime', (roomId, time) => {
        changeAnswerTime(roomId, time);
    });
    // 收到host 點遊戲開始按鈕的處理
    socket.on('startGame', roomId => handleStartGame(socket, roomId));
    // 收到participants端答案的處理
    socket.on('answer', data => handleReceiveAnswer(socket, data));
    // 收到host 按下一題目 才會跳轉下一題
    socket.on('oknext', roomId => displayInterimScoresAndProceed(roomId));
});
// 當使用者加入遊戲室 將其加入room participants和socket 並初始化分數
function handleJoinRoom(socket, roomId, username, callback) {
    const room = gameRooms[roomId];
    if (!room) {
        return callback(false);
    }
    if (!room.timeLeft) {
        room.timeLeft = room.QUESTION_TIME_LIMIT;
    }
    room.participants.push(username);
    socket.join(roomId);
    // 記錄使用者所在的遊戲室ID
    socket.roomId = roomId;
    socket.username = username;
    if (!room.scores[username]) {
        room.scores[username] = 0;
    }
    // 將使用者加入的資訊 傳到host.html
    io.to(room.host).emit('participantJoined', username, room.participants.length);
    callback({ success: true });
}
// 使用者退出遊戲時的處理
function handleDisconnect(socket) {
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = gameRooms[roomId];
    if (!room) return;
    
    // 從遊戲室中移除使用者
    const participantIndex = room.participants.indexOf(socket.username);
    if (participantIndex !== -1) {
        room.participants.splice(participantIndex, 1);
        // 通知host.html 用戶離開了
        io.to(room.host).emit('participantLeft', socket.username, room.participants.length);
        console.log("tell host",socket.username,"left");
        // 如果遊戲室已經沒其他人了，則可以删除遊戲室
        if (room.participants.length === 0) {
            delete gameRooms[roomId];
        }
    }
}

// 根據host點選 來設定該房間的 題目鑑別度
function changeLevel(roomId,level){
    const room = gameRooms[roomId];
    if(level == 1){
        room.QUESTIONS = QUESTIONS_1;
    }else if(level == 2){
        room.QUESTIONS = QUESTIONS_2;
    }else if(level == 3){
        room.QUESTIONS = QUESTIONS_3;
    }
    console.log("QUESTIONS",level);
}
// 根據host點選 來設定該房間的 題目數
function changeQuestionsNum(roomId,qNum){
    const room = gameRooms[roomId];
    if(qNum == 3){
        room.QUESTIONS_NUM = 3; 
    }else if(qNum == 5){
        room.QUESTIONS_NUM = 5;
    }else if(qNum == 10){
        room.QUESTIONS_NUM = 10;
    }
    console.log("room.QUESTIONS_NUM",room.QUESTIONS_NUM);
}
// 根據host點選 來設定該房間的 答題時間
function changeAnswerTime(roomId,time){
    const room = gameRooms[roomId];
    if(time == 5){
        room.QUESTION_TIME_LIMIT = 5;
    }else if(time == 7){
        room.QUESTION_TIME_LIMIT = 7;
    }else if(time == 10){
        room.QUESTION_TIME_LIMIT = 10;
    }
    console.log("QUESTION_TIME_LIMIT",room.QUESTION_TIME_LIMIT);
    io.to(roomId).emit('sendAnswerTimetoparti', room.QUESTION_TIME_LIMIT);
}

function handleStartGame(socket, roomId) {
    const room = gameRooms[roomId];
    // 無遊戲室錯誤時的處理
    if (!room || room.host !== socket.id) {return;}
    let countdown = COUNTDOWN_START;
    const countdownInterval = setInterval(() => {
        io.to(roomId).emit('countdown', countdown);
        countdown--;
        //　倒數結束 遊戲開始！
        if (countdown < 0) {
            clearInterval(countdownInterval);
            sendQuestionToRoom(roomId);
            startQuestionTimer(roomId);
        }
    }, 1000);
}
// 傳送"題目與選項"到host與participants
function sendQuestionToRoom(roomId) {
    console.log(roomId);
    const room = gameRooms[roomId];
    const question = room.QUESTIONS[room.currentQuestionIndex];
    io.to(roomId).emit('question', question);
}
// 問題作答 倒數計時處理
function startQuestionTimer(roomId) {
    const room = gameRooms[roomId];
    if (timers[roomId]) {
        clearInterval(timers[roomId]);
    }
    room.timeLeft = room.QUESTION_TIME_LIMIT;
    timers[roomId] = setInterval(() => {
        io.to(roomId).emit('timeUpdate', room.timeLeft);
        room.timeLeft--;
        // 當答題時間結束時的處理
        if (room.timeLeft < 0) {
            clearInterval(timers[roomId]);
            // Now we wait for host.html press nextbutton to send 'socket.on('oknext', roomId)
            // 在 console 中打印出發送的數據以確認
            console.log("room.answers", room.answers[room.currentQuestionIndex]);
            // 回傳所有使用者的答案 給host (顯示作答比例用)
            io.to(room.host).emit('allAnswers', room.QUESTIONS[room.currentQuestionIndex].options, room.answers[room.currentQuestionIndex]);
            // 
            io.to(roomId).emit('stopAnswer');
        }
    }, 1000);
}

// 當收到來自玩家(participants)端 送來的答案的處理
function handleReceiveAnswer(socket, data) {
    const room = gameRooms[data.roomId];
    if (!room || room.currentQuestionIndex >= room.QUESTIONS_NUM)  { return;}
    
    const currentQuestion = room.QUESTIONS[room.currentQuestionIndex];

    // 將使用者的答案 存儲到當前問題的答案集中
    if (!room.answers[room.currentQuestionIndex]) {
      room.answers[room.currentQuestionIndex] = {};
    }
    room.answers[room.currentQuestionIndex][data.user] = data.answer;

    if (data.answer === currentQuestion.answer) {
        // 計算分數(答對+速度)
        const timeBonus = room.timeLeft ? room.timeLeft : 0; // 取得剩餘的時間做為加分
        room.scores[data.user] = room.scores[data.user] + SCORE_INCREMENT + timeBonus;
        // 回傳 該玩家是否正確
        io.to(socket.id).emit('correct', { 
            user: data.user, 
            answer: data.answer,
            score: room.scores[data.user] });
    }
    // 回傳 該玩家更新後的分數
    io.to(socket.id).emit('feedback', `正確答案： ${currentQuestion.answer}`);
}

// 顯示當前各遊戲者的分數排名(題目與題目之間)
function displayInterimScoresAndProceed(roomId) {
    const room = gameRooms[roomId];
    console.log(room.scores);
    io.to(roomId).emit('displayInterimScores', room.scores);

    setTimeout(() => {
        // 若題目還不是最後一題，就傳送下一題
        if (room.currentQuestionIndex < room.QUESTIONS_NUM - 1) {
            room.currentQuestionIndex++;
            sendQuestionToRoom(roomId);
            startQuestionTimer(roomId);
            io.to(roomId).emit('hideInterimScores');
        } else {
            io.to(roomId).emit('end', 'Game over!');
            io.to(roomId).emit('finalScores', room.scores);
        }
    }, INTERIM_SCORE_DISPLAY_TIME * 1000);
}

app.use(express.static('public'));
// 預設的port 或 8080 
const port = process.env.PORT || 8080;
server.listen(port, () => {
    console.log(`listening on *:${port}`);
});