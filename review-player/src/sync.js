// 两个页面之间的状态通道。
// 主通道用 BroadcastChannel；file:// 下个别浏览器不支持时退化为 localStorage storage 事件。
// viewer 页只读主控页发出的快照，不回传任何控制指令。

const CHANNEL_NAME = 'review-player-sync-v1';
const STORAGE_KEY = 'review-player-snapshot-v1';

export class SnapshotChannel {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.lastSeq = -1;
    this.bc = null;
    if (typeof BroadcastChannel !== 'undefined') {
      this.bc = new BroadcastChannel(CHANNEL_NAME);
      this.bc.onmessage = (e) => this.#receive(e.data);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => {
        if (e.key === STORAGE_KEY && e.newValue) {
          try {
            this.#receive(JSON.parse(e.newValue));
          } catch {
            /* 忽略坏数据 */
          }
        }
      });
    }
  }

  #receive(snap) {
    if (!snap || typeof snap !== 'object' || snap.seq === undefined) return;
    if (snap.seq <= this.lastSeq) return; // 双通道去重 + 保序
    this.lastSeq = snap.seq;
    this.onMessage(snap);
  }

  post(snap) {
    if (this.bc) this.bc.postMessage(snap);
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
      } catch {
        /* 隐私模式等场景忽略 */
      }
    }
  }
}
