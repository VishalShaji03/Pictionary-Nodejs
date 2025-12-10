var express = require('express');
var app = express();
var serv = require('http').Server(app);
var file = require('fs');

// Default to client's index.html if no parameters are passed
app.get('/', function(req, res) {
	res.sendFile(__dirname + '/client/index.html');
});
app.use(express.static(__dirname + '/client'));

console.log('Server started at port 2000');
serv.listen(2000);

var SOCKET_LIST = {};
var gameStart = false;
var maxPlayerNumber = 8;
var chooseWordTime = 10000;
var drawTime = 30000;
var oneSecond = 1000;
var currIndex = 0;
var timeoutFunction;
var intervalFunction;
var remainSecond = 0;
var currWord;
var maxPoint;
var currPoint;
var words = [];
var inGamePlayers = [];
var successPlayer = [];
var io = require('socket.io')(serv, {});
io.sockets.on('connection', function(socket) {
    socket.id = Math.random();
    SOCKET_LIST[socket.id] = socket;

    Player.onConnect(socket);
    var players = getCurrentPlayers();
    socket.emit('updatePlayers', players);

    // Listen for joining game
    socket.on('join', function(data) {
        if(gameStart) {
            socket.emit('joinResponse', {success:false,msg:'Game has started.'});
        } else if(data.username.length >= 10) {
            socket.emit('joinResponse', {success:false,msg:'Name too long (<10).'});
        } else if(getCurrentPlayers().length == maxPlayerNumber) {
            socket.emit('joinResponse', {success:false,msg:'Maximum player# is 6.'});
        } else if(!checkValidCharacter(data.username)) {
            socket.emit('joinResponse', {success:false,msg:'Username can\'t contain special characters (<,>,\\,/,etc).'});
        } else if(validUsername(data.username)) {
            Player.list[socket.id].username = data.username;
            socket.emit('joinResponse', {success:true,username:data.username});
            updatePlayerList();
        } else {
            socket.emit('joinResponse', {success:false,msg:'User name taken.'});
        }
    });

    // Listen for ready event
    socket.on('ready', function(data) {
        // Game has started
        if(gameStart) return;

        // Test player exsists
        if(Player.list[socket.id] === '') return;

        Player.list[socket.id].ready = data.state;

        updatePlayerList();

        // Test game start
        var players = getCurrentPlayers();
        for(var i in players) {
            // If one person not ready
            if(!players[i].ready) return;
        }

        // Only one player
        if(players.length === 1) {
            sendMessage(SOCKET_LIST[socket.id], 'Please wait for other players.');
            return;
        }

        // Game start
        gameStart = true;
        inGamePlayers = players;
        maxPoint = inGamePlayers.length;

        // Let all players know the game has started
        for(var i in inGamePlayers) {
            SOCKET_LIST[inGamePlayers[i].id].emit('gameStart', {});
        }

        // Initalize words
        var lineNumbers = getLineNumebrs(65);

        // Read from file
        // Words from https://www.thegamegal.com/printables/
        file.readFile('./Words.txt', 'utf8', function(err, content) {
            if(err) console.log(err);
            else {
                words = [];
                content = content.split('\n');

                for(var i in lineNumbers)
                    words.push(content[lineNumbers[i]]);

                console.log(words);

                // Let the first player choose words
                chooseWord();
            }
        });
    });

    // Player choose word
    socket.on('chosenWord', function(data) {
        // Random word package has sent, game has started
        if(currWord !== '') return;

        // Clear count down and time out
        clearInterval(intervalFunction);
        intervalFunction = null;
        socket.emit('remainTime', {time:0});
        clearTimeout(timeoutFunction);
        timeoutFunction = null;
        
        // Retrieve and remove word
        var number = parseInt(data.number)-1;
        if(number >= 0 && number < words.length && words[number] !== '') {
            currWord = words[number];
            console.log("Chosen word is " + currWord + " ");
            words[number] = '';
        }

        // Send this word to client
        socket.emit('chosenWord', {word:currWord});

        // Start this round
        startRound(socket);
    });

    // Drawing board update to all except the current drawer
    socket.on('drawData', function(data) {
        for(var i in inGamePlayers) {
            if(socket.id !== inGamePlayers[i].id) {
                SOCKET_LIST[inGamePlayers[i].id].emit('drawData', {data:data.data});
            }
        }
    });

    // Receive an attempt and broadcast to all
    socket.on('answer', function(data) {
        // This player is the drawing player
        if(socket.id === inGamePlayers[currIndex].id) return;

        // This player has guessed correctly before
        for(var i in successPlayer) {
            if(successPlayer[i] === socket.id) return;
        }

        if(data.answer === currWord) {
            var player = Player.list[socket.id];
            player.point += currPoint;
            for(var i in inGamePlayers) {
                SOCKET_LIST[inGamePlayers[i].id].emit('answerResponse', {playerName:player.username,point:player.point,increment:currPoint,success:true});
            }
            successPlayer.push(socket.id);
            currPoint--;
        } else {
            var playerName = Player.list[socket.id].username;
            for(var i in inGamePlayers) {
                SOCKET_LIST[inGamePlayers[i].id].emit('answerResponse', {playerName:playerName,data:escapeSpecialCharacters(data.answer),success:false});
            }
        }
    });

    // Listen for player msg
    socket.on('msg', function(data) {
        // If this is not from in-game player, ignore it
        var name = Player.list[socket.id].username;
        if(name === '') return;

        for(var i in SOCKET_LIST) {
            sendMessage(SOCKET_LIST[i], name + ": " + data.msg);
        }
    });

    // Close socket and notify users
    socket.on('disconnect', function() {
        var playerName = Player.list[socket.id].username;
        Player.onDisconnect(socket);

        // Ignore if this player is not in game
        if(playerName !== '') {
            var remainPlayers = getCurrentPlayers();

            // Send this info to other players
            for(var i in SOCKET_LIST) {
                if(socket.id !== i.id)
                    SOCKET_LIST[i].emit('leave', {player:playerName,playerNumber:remainPlayers.length});
            }
        }

        // If this player is in game
        for(var i = 0; i < inGamePlayers.length; i++) {
            if(inGamePlayers[i].id === socket.id) {
                // If this player is the drawing one, send answer
                if(i === currIndex) {
                    // Clear count down and time out
                    if(timeoutFunction != null) clearTimeout(timeoutFunction);
                    timeoutFunction = null;
                    if(intervalFunction != null) clearInterval(intervalFunction);
                    intervalFunction = null;
                    sendTime(0);

                    // Send answer and next player
                    sendResult(socket);
                    currIndex--;
                }

                // Remove player from list
                inGamePlayers.splice(i, 1);
                break;
            }
        }

        delete SOCKET_LIST[socket.id];

        // All players left, stop the server and reset game
        if(inGamePlayers.length === 0) {
            if(timeoutFunction != null) clearTimeout(timeoutFunction);
            resetGame();
        } else if(inGamePlayers.length === 1) {
            // Only one player left
            gameOver();
        } else {
            // Next player please
            if(gameStart) nextPlayer();
        }
    });
});

function validUsername(username) {
    for(var i in Player.list) {
        if(Player.list[i].username === username) {
            return false;
        }
    }

    return true;
}

function checkValidCharacter(str) {
    for(var i in str) {
        if(str[i] === '<' || str[i] === '>' || str[i] === '/' || str[i] === '\\')
            return false;
    }
    return true;
}

// Send current room data to all players
function updatePlayerList() {
    var remainPlayers = getCurrentPlayers();
    for(var i in Player.list) {
        SOCKET_LIST[i].emit('updatePlayers', {players:remainPlayers});
    }
}

function getCurrentPlayers() {
    var players = [];
    for(var i in Player.list) {
        if(Player.list[i].username !== '') players.push(Player.list[i]);
    }

    return players;
}

function sendMessage(socket, msg) {
    socket.emit('msg', {msg:escapeSpecialCharacters(msg)});
}

function getLineNumebrs(length) {
    var result = [];
    loop1: for(var i = 0; i < 8; i++) {
        var newNumber = Math.floor(Math.random()*length);
        for(var j in result) {
            if(result[j] === newNumber) {
                i--;
                continue loop1;
            }
        }
        result.push(newNumber);
    }
    return result;
}

function chooseWord() {
    // Send word options to the player with current id
    var currentPlayer = inGamePlayers[currIndex];
    var numbers = [];
    for(var i = 0; i < words.length; i++) {
        if(words[i] !== '') numbers.push(i+1);
    }
    currWord = '';
    sendMessage(SOCKET_LIST[currentPlayer.id], '===================');
    SOCKET_LIST[currentPlayer.id].emit('chooseWord', {numbers:numbers});

    // Send count down and timeout
    SOCKET_LIST[currentPlayer.id].emit('remainTime', {time:chooseWordTime/oneSecond});
    remainSecond = chooseWordTime-oneSecond;
    intervalFunction = setInterval(function() {
        sendTime(remainSecond/oneSecond);
        remainSecond -= oneSecond;
    }, oneSecond);
    timeoutFunction = setTimeout(function(){
        clearInterval(intervalFunction);
        intervalFunction = null;
        sendTime(0);
        chooseRandomWord(SOCKET_LIST[currentPlayer.id]);
    }, chooseWordTime);

    // Let other players know the progress
    for(var i in SOCKET_LIST) {
        sendMessage(SOCKET_LIST[i], '===================');
        if(SOCKET_LIST[i].id != currentPlayer.id) {
            sendMessage(SOCKET_LIST[i], currentPlayer.username + ' is choosing word...');
        }
    }
}

function chooseRandomWord(socket) {
    var number = Math.floor(Math.random()*words.length);
    for(var i = number; i < words.length; i++) {
        if(words[i] !== '') {
            currWord = words[i];
            words[i] = '';
            socket.emit('chosenWord', {word:currWord});
            console.log("Chosen word is " + currWord + " with number=" + number + " i=" + i);
            break;
        }

        if(i == words.length-1) i = 0;
    }

    startRound(socket);
}

function startRound(socket) {
    // Wait for 3 second
    timeoutFunction = setTimeout(function() {
        currPoint = maxPoint;
        successPlayer = [];

        // Prepare other clients to guess
        for(var i in inGamePlayers) {
            if(inGamePlayers[i].id !== socket.id) {
                SOCKET_LIST[inGamePlayers[i].id].emit('guess',{wordLength:currWord.length});
            }
        }

        // Let player start drawing
        socket.emit('startDrawing');

        // Count down time
        sendTime(drawTime/oneSecond);
        remainSecond = drawTime-oneSecond;
        intervalFunction = setInterval(function() {
            sendTime(remainSecond/oneSecond);
            remainSecond -= oneSecond;
        }, oneSecond);

        // 60 seconds to draw
        timeoutFunction = setTimeout(function() {
            // Times up, clear count down
            clearInterval(intervalFunction);
            intervalFunction = null;
            sendTime(0);
            for(var i in inGamePlayers) {
                SOCKET_LIST[inGamePlayers[i].id].emit('timesUp');
            }

            // Let other players know the result
            sendResult(socket);
            currWord = '';

            // 3s move on to next player
            timeoutFunction = setTimeout(function() {
                nextPlayer();
            }, 3000);
        }, drawTime);
    }, 3000);
}

function sendResult(socket) {
    for(var i in inGamePlayers) {
        if(inGamePlayers[i].id !== socket.id)
            SOCKET_LIST[inGamePlayers[i].id].emit('result', {word:currWord});
    }
}

function sendTime(time) {
    for(var i in inGamePlayers) {
        SOCKET_LIST[inGamePlayers[i].id].emit('remainTime', {time:time});
    }
}

function nextPlayer() {
    // Next player or game over
    if(++currIndex >= inGamePlayers.length) {
        gameOver();
    } else {
        chooseWord();
    }
}

function gameOver() {
    timeoutFunction = null;

    // Count winners
    var players = [];
    var maxAmount = -1;
    for(var i in inGamePlayers) {
        if(inGamePlayers[i].point > maxAmount) {
            maxAmount = inGamePlayers[i].point;
            players = [];
            players.push(inGamePlayers[i].username);
        } else if(inGamePlayers[i].point == maxAmount) {
            players.push(inGamePlayers[i].username);
        }
    }

    for(var i in inGamePlayers) {
        sendMessage(SOCKET_LIST[inGamePlayers[i].id], '===================');
        SOCKET_LIST[inGamePlayers[i].id].emit('gameOver', {msg:'Thanks for playing!',winner:players});
        sendMessage(SOCKET_LIST[inGamePlayers[i].id], '===================');
    }
    resetGame();
}

function resetGame() {
    gameStart = false;
    currIndex = 0;
    for(var i in inGamePlayers) {
        inGamePlayers[i].point = 0;
        inGamePlayers[i].ready = false;
    }
    inGamePlayers = [];
    updatePlayerList();
}

function escapeSpecialCharacters(msg) {
    // Replace special characters
    for(var i = msg.length; i >= 0; i--) {
        if(msg[i] === '<') {
            msg = msg.slice(0, i) + '&lt;' + msg.slice(i+1);
        } else if(msg[i] === '>') {
            msg = msg.slice(0, i) + '&gt;' + msg.slice(i+1);
        }
    }

    return msg;
}

var Player = function(socketId) {
    var self = {
        id:socketId,
        username:"",
        ready:false,
        point:0,
    }

    Player.list[self.id] = self;

    return self;
}
Player.list = {};
Player.onConnect = function(socket) {
    Player(socket.id);
}
Player.onDisconnect = function(socket) {
    delete Player.list[socket.id];
}
