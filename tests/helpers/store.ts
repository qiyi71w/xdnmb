import type { ReadingStore } from '../../src/main/storage/contract'
import type { ReadingDatabase } from '../../src/main/storage/database'

/** The async store interface over a real SQLite database, without the worker thread. */
export function asStore(db: ReadingDatabase): ReadingStore {
  return {
    get status() {
      return db.status
    },
    saveDirectory: async (...args) => db.saveDirectory(...args),
    loadDirectory: async () => db.loadDirectory(),
    saveFeedPage: async (...args) => db.saveFeedPage(...args),
    loadFeedPage: async (...args) => db.loadFeedPage(...args),
    saveThreadPage: async (...args) => db.saveThreadPage(...args),
    loadThreadPage: async (...args) => db.loadThreadPage(...args),
    getThreadCoverage: async (...args) => db.getThreadCoverage(...args),
    savePost: async (...args) => db.savePost(...args),
    loadPost: async (...args) => db.loadPost(...args),
    findPostThread: async (...args) => db.findPostThread(...args),
    getReadingState: async (...args) => db.getReadingState(...args),
    setReadingMode: async (...args) => db.setReadingMode(...args),
    saveReadingPosition: async (...args) => db.saveReadingPosition(...args),
    markPostsRead: async (...args) => db.markPostsRead(...args),
    recordVisit: async (...args) => db.recordVisit(...args),
    establishAttention: async (...args) => db.establishAttention(...args),
    loadSettings: async () => db.loadSettings(),
    saveSettings: async (...args) => db.saveSettings(...args),
    getPostImage: async (...args) => db.getPostImage(...args),
    findImageResource: async (...args) => db.findImageResource(...args),
    commitImageResource: async (...args) => db.commitImageResource(...args),
    releaseImageHolders: async (...args) => db.releaseImageHolders(...args),
    deleteUnheldImages: async (...args) => db.deleteUnheldImages(...args),
    listImageFileNames: async () => db.listImageFileNames(),
    close: async () => db.close()
  }
}
