import { parentPort, workerData } from 'node:worker_threads'
import type { StorageStatus } from '../../shared/api'
import { StorageWriteRefusedError } from './contract'
import { openReadingDatabase } from './database'
import type { ReadingDatabase } from './database'

export type StorageMethod = Exclude<keyof ReadingDatabase, 'status'>
export type StorageRequest = {
  [Method in StorageMethod]: {
    id: number
    method: Method
    args: Parameters<ReadingDatabase[Method]>
  }
}[StorageMethod]

export type StorageResponse =
  | { type: 'ready'; status: StorageStatus }
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: { name: string; message: string; status?: StorageStatus } }

const port = parentPort
if (!port) throw new Error('reading database requires a worker parent')
const data = workerData as { databasePath: string }
const db = openReadingDatabase(data.databasePath)
port.postMessage({ type: 'ready', status: db.status } satisfies StorageResponse)

port.on('message', (request: StorageRequest) => {
  const id = request?.id
  if (!Number.isSafeInteger(id)) return
  try {
    if (!Array.isArray(request.args)) throw new Error('invalid storage request')
    let value: unknown
    switch (request.method) {
      case 'searchBoundary': value = db.searchBoundary(...request.args); break
      case 'searchBatch': value = db.searchBatch(...request.args); break
      case 'beginSearchRebuild': value = db.beginSearchRebuild(...request.args); break
      case 'rebuildSearchBatch': value = db.rebuildSearchBatch(...request.args); break
      case 'searchMetadata': value = db.searchMetadata(...request.args); break
      case 'saveDirectory': value = db.saveDirectory(...request.args); break
      case 'loadDirectory': value = db.loadDirectory(...request.args); break
      case 'saveFeedPage': value = db.saveFeedPage(...request.args); break
      case 'loadFeedPage': value = db.loadFeedPage(...request.args); break
      case 'saveThreadPage': value = db.saveThreadPage(...request.args); break
      case 'loadThreadPage': value = db.loadThreadPage(...request.args); break
      case 'getThreadCoverage': value = db.getThreadCoverage(...request.args); break
      case 'savePost': value = db.savePost(...request.args); break
      case 'loadPost': value = db.loadPost(...request.args); break
      case 'findPostThread': value = db.findPostThread(...request.args); break
      case 'getReadingState': value = db.getReadingState(...request.args); break
      case 'setReadingMode': value = db.setReadingMode(...request.args); break
      case 'saveReadingPosition': value = db.saveReadingPosition(...request.args); break
      case 'recordVisit': value = db.recordVisit(...request.args); break
      case 'loadSettings': value = db.loadSettings(...request.args); break
      case 'saveSettings': value = db.saveSettings(...request.args); break
      case 'loadAnnouncements': value = db.loadAnnouncements(...request.args); break
      case 'saveAnnouncements': value = db.saveAnnouncements(...request.args); break
      case 'loadAnalytics': value = db.loadAnalytics(...request.args); break
      case 'saveAnalytics': value = db.saveAnalytics(...request.args); break
      case 'listBlocks': value = db.listBlocks(...request.args); break
      case 'setBlock': value = db.setBlock(...request.args); break
      case 'listCookieColors': value = db.listCookieColors(...request.args); break
      case 'addCookieColor': value = db.addCookieColor(...request.args); break
      case 'setCookieColor': value = db.setCookieColor(...request.args); break
      case 'removeCookieColor': value = db.removeCookieColor(...request.args); break
      case 'getPostImage': value = db.getPostImage(...request.args); break
      case 'findImageResource': value = db.findImageResource(...request.args); break
      case 'commitImageResource': value = db.commitImageResource(...request.args); break
      case 'releaseImageHolders': value = db.releaseImageHolders(...request.args); break
      case 'deleteUnheldImages': value = db.deleteUnheldImages(...request.args); break
      case 'listImageFileNames': value = db.listImageFileNames(...request.args); break
      case 'loadAccountSession': value = db.loadAccountSession(...request.args); break
      case 'saveAccountSession': value = db.saveAccountSession(...request.args); break
      case 'clearAccountSession': value = db.clearAccountSession(...request.args); break
      case 'listCredentials': value = db.listCredentials(...request.args); break
      case 'loadCredentialCiphertexts': value = db.loadCredentialCiphertexts(...request.args); break
      case 'loadCredentialCiphertext': value = db.loadCredentialCiphertext(...request.args); break
      case 'insertCredential': value = db.insertCredential(...request.args); break
      case 'renameCredential': value = db.renameCredential(...request.args); break
      case 'fillCredentialCookieId': value = db.fillCredentialCookieId(...request.args); break
      case 'setCredentialCookieId': value = db.setCredentialCookieId(...request.args); break
      case 'deleteCredential': value = db.deleteCredential(...request.args); break
      case 'reorderCredentials': value = db.reorderCredentials(...request.args); break
      case 'loadRoleSelections': value = db.loadRoleSelections(...request.args); break
      case 'setRoleSelection': value = db.setRoleSelection(...request.args); break
      case 'listDrafts': value = db.listDrafts(...request.args); break
      case 'saveDraft': value = db.saveDraft(...request.args); break
      case 'deleteDraft': value = db.deleteDraft(...request.args); break
      case 'insertDraftAttachment': value = db.insertDraftAttachment(...request.args); break
      case 'getDraftAttachment': value = db.getDraftAttachment(...request.args); break
      case 'deleteUnreferencedAttachments': value = db.deleteUnreferencedAttachments(...request.args); break
      case 'listDraftAttachmentFileNames': value = db.listDraftAttachmentFileNames(...request.args); break
      case 'getThreadPostIdentity': value = db.getThreadPostIdentity(...request.args); break
      case 'setThreadPostIdentity': value = db.setThreadPostIdentity(...request.args); break
      case 'listHistory': value = db.listHistory(...request.args); break
      case 'listOffline': value = db.listOffline(...request.args); break
      case 'clearHistory': value = db.clearHistory(...request.args); break
      case 'getContentUsage': value = db.getContentUsage(...request.args); break
      case 'setCacheLimit': value = db.setCacheLimit(...request.args); break
      case 'evictContentBatch': value = db.evictContentBatch(...request.args); break
      case 'holdContentReader': value = db.holdContentReader(...request.args); break
      case 'releaseContentReaders': value = db.releaseContentReaders(...request.args); break
      case 'getOfflineCopy': value = db.getOfflineCopy(...request.args); break
      case 'deleteOfflineCopy': value = db.deleteOfflineCopy(...request.args); break
      case 'beginOfflineCopy': value = db.beginOfflineCopy(...request.args); break
      case 'saveOfflinePage': value = db.saveOfflinePage(...request.args); break
      case 'updateOfflineCopy': value = db.updateOfflineCopy(...request.args); break
      case 'holdOfflineImage': value = db.holdOfflineImage(...request.args); break
      case 'listOfflineImagePosts': value = db.listOfflineImagePosts(...request.args); break
      case 'recoverContent': value = db.recoverContent(...request.args); break
      case 'loadSubscriptionConfiguration': value = db.loadSubscriptionConfiguration(...request.args); break
      case 'setSubscriptionAppCredential': value = db.setSubscriptionAppCredential(...request.args); break
      case 'loadSubscriptionAppCiphertext': value = db.loadSubscriptionAppCiphertext(...request.args); break
      case 'setSubscriptionSource': value = db.setSubscriptionSource(...request.args); break
      case 'loadSubscriptionObservation': value = db.loadSubscriptionObservation(...request.args); break
      case 'loadSubscriptionObservationById': value = db.loadSubscriptionObservationById(...request.args); break
      case 'saveSubscriptionObservation': value = db.saveSubscriptionObservation(...request.args); break
      case 'saveSubscriptionOperation': value = db.saveSubscriptionOperation(...request.args); break
      case 'loadSubscriptionOperations': value = db.loadSubscriptionOperations(...request.args); break
      case 'recoverSubscriptionOperations': value = db.recoverSubscriptionOperations(...request.args); break
      case 'listSubscriptionAppCredentials': value = db.listSubscriptionAppCredentials(...request.args); break
      case 'loadSubscriptionBaseline': value = db.loadSubscriptionBaseline(...request.args); break
      case 'loadSubscriptionPlans': value = db.loadSubscriptionPlans(...request.args); break
      case 'saveSubscriptionPlan': value = db.saveSubscriptionPlan(...request.args); break
      case 'recoverSubscriptionPlans': value = db.recoverSubscriptionPlans(...request.args); break
      case 'createPublication': value = db.createPublication(...request.args); break
      case 'listPublications': value = db.listPublications(...request.args); break
      case 'getPublication': value = db.getPublication(...request.args); break
      case 'finishPublication': value = db.finishPublication(...request.args); break
      case 'recoverPublications': value = db.recoverPublications(...request.args); break
      case 'failUnverifiedPublication': value = db.failUnverifiedPublication(...request.args); break
      case 'listLaunchNotices': value = db.listLaunchNotices(...request.args); break
      case 'dismissLaunchNotices': value = db.dismissLaunchNotices(...request.args); break
      case 'loadWorkspace': value = db.loadWorkspace(...request.args); break
      case 'saveWorkspace': value = db.saveWorkspace(...request.args); break
      case 'getPoWarningEnabled': value = db.getPoWarningEnabled(...request.args); break
      case 'setPoWarningEnabled': value = db.setPoWarningEnabled(...request.args); break
      case 'lastPublicationAt': value = db.lastPublicationAt(...request.args); break
      case 'getReminderRules': value = db.getReminderRules(...request.args); break
      case 'setReminderRule': value = db.setReminderRule(...request.args); break
      case 'closeReminderThreads': value = db.closeReminderThreads(...request.args); break
      case 'reminderRuleSnapshots': value = db.reminderRuleSnapshots(...request.args); break
      case 'reminderStates': value = db.reminderStates(...request.args); break
      case 'reminderCookieIds': value = db.reminderCookieIds(...request.args); break
      case 'reminderQuoteSources': value = db.reminderQuoteSources(...request.args); break
      case 'updateReminderState': value = db.updateReminderState(...request.args); break
      case 'reminderIncreasedThreads': value = db.reminderIncreasedThreads(...request.args); break
      case 'clearReminderCounts': value = db.clearReminderCounts(...request.args); break
      case 'finishReminderCheck': value = db.finishReminderCheck(...request.args); break
      case 'loadReminderBackoff': value = db.loadReminderBackoff(...request.args); break
      case 'saveReminderBackoff': value = db.saveReminderBackoff(...request.args); break
      case 'reminderOverview': value = db.reminderOverview(...request.args); break
      case 'close': value = db.close(...request.args); break
      default: throw new Error('unknown storage method')
    }
    port.postMessage({ id, ok: true, value } satisfies StorageResponse)
    if (request.method === 'close') port.close()
  } catch (error) {
    const refusal = error instanceof StorageWriteRefusedError
    port.postMessage({
      id,
      ok: false,
      error: {
        name: refusal ? error.name : 'Error',
        message: refusal ? error.message : 'database operation failed',
        ...(refusal ? { status: error.status } : {})
      }
    } satisfies StorageResponse)
    if (request.method === 'close') port.close()
  }
})
