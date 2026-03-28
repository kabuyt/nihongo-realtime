// Cloudflare Worker - にほんご リアルタイム かいわ
// OpenAI Realtime API WebSocket リレー
// APIキーをブラウザから隠す中継サーバー

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

  // URL パラメータからモデルを取得（デフォルト: gpt-4o-mini-realtime-preview）
  const url = new URL(request.url);
  const model = url.searchParams.get('model') || 'gpt-4o-mini-realtime-preview';

  // OpenAI Realtime API に接続
  let openaiSocket;
  try {
    const openaiResp = await fetch(
      `https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
      {
        headers: {
          'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1',
          'Upgrade': 'websocket',
          'Connection': 'Upgrade',
        },
      }
    );

    openaiSocket = openaiResp.webSocket;
    if (!openaiSocket) {
      // OpenAI への接続失敗
      const errBody = await openaiResp.text().catch(() => '(no body)');
      serverSocket.close(1011, `OpenAI 接続失敗 (${openaiResp.status}): ${errBody.slice(0, 100)}`);
      return new Response(null, { status: 101, webSocket: clientSocket });
    }
    openaiSocket.accept();
  } catch (err) {
    serverSocket.close(1011, `接続エラー: ${err.message}`);
    return new Response(null, { status: 101, webSocket: clientSocket });
  }

  // ===== 双方向リレー =====

  // クライアント → OpenAI
  serverSocket.addEventListener('message', (event) => {
    try {
      if (openaiSocket.readyState === 1 /* OPEN */) {
        openaiSocket.send(event.data);
      }
    } catch (err) {
      console.error('Client→OpenAI relay error:', err);
    }
  });

  // OpenAI → クライアント
  openaiSocket.addEventListener('message', (event) => {
    try {
      if (serverSocket.readyState === 1 /* OPEN */) {
        serverSocket.send(event.data);
      }
    } catch (err) {
      console.error('OpenAI→Client relay error:', err);
    }
  });

  // クローズハンドリング
  serverSocket.addEventListener('close', (event) => {
    try { openaiSocket.close(event.code || 1000, event.reason || 'クライアント切断'); } catch (_) {}
  });

  openaiSocket.addEventListener('close', (event) => {
    try { serverSocket.close(event.code || 1000, event.reason || 'OpenAI 切断'); } catch (_) {}
  });

  serverSocket.addEventListener('error', () => {
    try { openaiSocket.close(1011, 'クライアントエラー'); } catch (_) {}
  });

  openaiSocket.addEventListener('error', () => {
    try { serverSocket.close(1011, 'OpenAI エラー'); } catch (_) {}
  });

  return new Response(null, { status: 101, webSocket: clientSocket });
}
