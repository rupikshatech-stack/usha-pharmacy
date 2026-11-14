import { ApiError } from '../../../utils/ApiError.js';

/**
 * A place-holder for an integration planned for Phase 2. It is registered so it can be chosen by name (and so the status says exactly what is
 * missing), but it never reads anything: `implemented` is false, so it is never reported as ready. To build the real one, replace this with an
 * object that has the same shape (see invoiceExtraction/index.js) and whose extract() calls the service and maps its answer onto RawInvoice.
 */
export const plannedProvider = (label, setting) => ({
  label,
  implemented: false,
  setup: `Its credentials will be read from the server environment (starting with ${setting}) once the integration is built.`,
  isConfigured: () => false,
  async extract() {
    throw new ApiError(501, `${label} is not connected yet (planned for Phase 2).`, undefined, 'AI_NOT_CONFIGURED');
  },
});
