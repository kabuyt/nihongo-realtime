// Cloudflare Worker - にほんご リアルタイム かいわ
// Gemini Live API WebSocket リレー
// APIキーをブラウザから隠す中継サーバー

const GEMINI_WS_HOST = 'generativelanguage.googleapis.com';
const GEMINI_WS_PATH = '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS プリフライト
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // ヘルスチェック
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', ts: Date.now() }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // WebSocket アップグレードのみ受け付ける
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response(
        'このエンドポイントは WebSocket 接続専用です。\nws:// または wss:// で接続してください。',
        { status: 426, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
      );
    }

    return handleWebSocket(request, env);
  },
};

async function handleWebSocket(request, env) {
  // クライアント向け WebSocket ペアを作成
  const { 0: clientSocket, 1: serverSocket } = new WebSocketPair();
  serverSocket.accept();

  if (!env.GEMINI_API_KEY) {
    serverSocket.close(1011, 'GEMINI_API_KEY が未設定です');
    return new Response(null, { status: 101, webSocket: clientSocket });
  }

  // Gemini Live API に接続（API キーは URL クエリで渡す）
  const geminiUrl = `wss://${GEMINI_WS_HOST}${GEMINI_WS_PATH}?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;

  let geminiSocket;
  try {
    const geminiResp = await fetch(geminiUrl, {
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
      },
    });

    geminiSocket = geminiResp.webSocket;
    if (!geminiSocket) {
      const errBody = await geminiResp.text().catch(() => '(no body)');
      serverSocket.close(1011, `Gemini 接続失敗 (${geminiResp.status}): ${errBody.slice(0, 100)}`);
      return new Response(null, { status: 101, webSocket: clientSocket });
    }
    geminiSocket.accept();
  } catch (err) {
    serverSocket.close(1011, `接続エラー: ${err.message}`);
    return new Response(null, { status: 101, webSocket: clientSocket });
  }

  // ===== 双方向リレー =====

  // クライアント → Gemini
  serverSocket.addEventListener('message', (event) => {
    try {
      if (geminiSocket.readyState === 1 /* OPEN */) {
        geminiSocket.send(event.data);
      }
    } catch (err) {
      console.error('Client→Gemini relay error:', err);
    }
  });

  // Gemini → クライアント
  geminiSocket.addEventListener('message', (event) => {
    try {
      if (serverSocket.readyState === 1 /* OPEN */) {
        serverSocket.send(event.data);
      }
    } catch (err) {
      console.error('Gemini→Client relay error:', err);
    }
  });

  // クローズハンドリング
  serverSocket.addEventListener('close', (event) => {
    try { geminiSocket.close(event.code || 1000, event.reason || 'クライアント切断'); } catch (_) {}
  });

  geminiSocket.addEventListener('close', (event) => {
    try { serverSocket.close(event.code || 1000, event.reason || 'Gemini 切断'); } catch (_) {}
  });

  serverSocket.addEventListener('error', () => {
    try { geminiSocket.close(1011, 'クライアントエラー'); } catch (_) {}
  });

  geminiSocket.addEventListener('error', () => {
    try { serverSocket.close(1011, 'Gemini エラー'); } catch (_) {}
  });

  return new Response(null, { status: 101, webSocket: clientSocket });
}
