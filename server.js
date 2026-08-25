<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
  <title>Eagles Nest Chat</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: linear-gradient(145deg, #07111f 0%, #0c1c32 40%, #0a1628 100%);
      background-attachment: fixed;
      color: #f0f4f8;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      padding: 16px;
    }

    /* ===== Glass utility ===== */
    .glass {
      background: rgba(255, 255, 255, 0.07);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 18px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    }

    /* ===== Login Screen ===== */
    #login {
      max-width: 400px;
      width: 100%;
      margin: 10vh auto 0;
      padding: 2.75rem 2.25rem;
      text-align: center;
    }

    #login h2 {
      font-size: 1.75rem;
      font-weight: 700;
      letter-spacing: -0.03em;
      margin-bottom: 0.4rem;
      color: #ffffff;
    }

    #login p {
      opacity: 0.7;
      font-size: 0.95rem;
      margin-bottom: 1.75rem;
    }

    #usernameInput,
    #trackingInput {
      width: 100%;
      padding: 0.9rem 1.1rem;
      margin-bottom: 0.9rem;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 12px;
      color: #fff;
      font-size: 1rem;
      outline: none;
      transition: all 0.2s ease;
    }

    #usernameInput::placeholder,
    #trackingInput::placeholder {
      color: rgba(255, 255, 255, 0.45);
    }

    #usernameInput:focus,
    #trackingInput:focus {
      background: rgba(255, 255, 255, 0.12);
      border-color: rgba(255, 255, 255, 0.35);
      box-shadow: 0 0 0 3px rgba(196, 30, 58, 0.25);
    }

    #login button {
      width: 100%;
      padding: 0.95rem;
      margin-top: 0.4rem;
      background: linear-gradient(135deg, #c41e3a 0%, #9b1b2e 100%);
      border: none;
      border-radius: 12px;
      color: white;
      font-weight: 600;
      font-size: 1.05rem;
      cursor: pointer;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
    }

    #login button:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(196, 30, 58, 0.45);
    }

    #login button:active {
      transform: translateY(0);
    }

    /* ===== Chat Interface ===== */
    #chat {
      display: none;
      flex-direction: column;
      height: calc(100vh - 32px);
      max-width: 920px;
      width: 100%;
      margin: 0 auto;
      overflow: hidden;
    }

    #chat > h2 {
      padding: 1.1rem 1.4rem;
      font-size: 1.25rem;
      font-weight: 600;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      flex-shrink: 0;
    }

    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 0.55rem;
    }

    /* Custom scrollbar */
    #messages::-webkit-scrollbar {
      width: 6px;
    }
    #messages::-webkit-scrollbar-track {
      background: transparent;
    }
    #messages::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.2);
      border-radius: 3px;
    }

    .msg {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 14px;
      padding: 0.7rem 1rem;
      max-width: 88%;
      word-wrap: break-word;
      line-height: 1.45;
      animation: fadeIn 0.25s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(6px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    .msg .username {
      color: #ff6b6b;
      font-weight: 600;
      margin-right: 0.35rem;
    }

    .msg .cranky {
      color: #ffd700;
      font-weight: 700;
      margin-right: 0.35rem;
    }

    .msg.system {
      background: transparent;
      border: none;
      color: #a0aec0;
      font-style: italic;
      text-align: center;
      max-width: 100%;
      font-size: 0.9rem;
      opacity: 0.8;
    }

    /* Input bar */
    #form {
      display: flex;
      gap: 0.75rem;
      padding: 1rem 1.25rem;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(255, 255, 255, 0.04);
      flex-shrink: 0;
    }

    #input {
      flex: 1;
      padding: 0.9rem 1.15rem;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 12px;
      color: white;
      font-size: 1rem;
      outline: none;
      transition: border-color 0.2s, background 0.2s;
    }

    #input::placeholder {
      color: rgba(255, 255, 255, 0.4);
    }

    #input:focus {
      background: rgba(255, 255, 255, 0.12);
      border-color: rgba(255, 255, 255, 0.35);
    }

    #form button {
      padding: 0 1.5rem;
      background: linear-gradient(135deg, #c41e3a 0%, #9b1b2e 100%);
      border: none;
      border-radius: 12px;
      color: white;
      font-weight: 600;
      font-size: 1rem;
      cursor: pointer;
      transition: transform 0.15s, box-shadow 0.15s;
      white-space: nowrap;
    }

    #form button:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 18px rgba(196, 30, 58, 0.4);
    }
  </style>
</head>
<body>
  <!-- Login -->
  <div id="login" class="glass">
    <h2>Welcome to Eagles Nest</h2>
    <p>Enter a username to join the chat</p>
    <input id="usernameInput" placeholder="Your username" maxlength="20" />
    <input id="trackingInput" placeholder="Tracking # (optional)" maxlength="40" />
    <button onclick="joinChat()">Join Chat</button>
  </div>

  <!-- Chat -->
  <div id="chat" class="glass">
    <h2>Eagles Nest Chat</h2>
    <div id="messages"></div>
    <form id="form">
      <input id="input" autocomplete="off" placeholder="Type a message..." />
      <button>Send</button>
    </form>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const socket = io();
    let username = '';

    function joinChat() {
      const username = document.getElementById('usernameInput').value.trim();
      const tracking = document.getElementById('trackingInput').value.trim();

      if (username.length < 2) {
        alert('Username must be at least 2 characters');
        return;
      }

      document.getElementById('login').style.display = 'none';
      document.getElementById('chat').style.display = 'flex';

      // Send both username and tracking number
      socket.emit('join', { username, tracking });
    }

    const form = document.getElementById('form');
    const input = document.getElementById('input');
    const messages = document.getElementById('messages');

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (input.value) {
        socket.emit('chat message', input.value);
        input.value = '';
      }
    });

    socket.on('chat message', (data) => {
      const div = document.createElement('div');
      div.className = 'msg';
      const nameClass = data.username === 'Cranky Eagle' ? 'cranky' : 'username';
      div.innerHTML = '<span class="' + nameClass + '">' + data.username + ':</span> ' + data.message;
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
    });

    socket.on('system', (msg) => {
      const div = document.createElement('div');
      div.className = 'msg system';
      div.textContent = msg;
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
    });
  </script>
</body>
</html>