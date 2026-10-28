import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules, PaymentActions } from "@medusajs/framework/utils"
import { processPaymentWorkflow } from "@medusajs/medusa/core-flows"

const PROVIDER_ID = "pp_paystation_paystation"
const LOOKBACK_HOURS = 24
const BATCH_SIZE = 50

// Backstop for PayStation IPNs that never arrive (always the case with the shared
// sandbox merchant) or arrive before the status API reports success: completes
// carts whose invoice was paid while the shopper never came back to the store.
export default async function reconcilePayStationPayments(container: MedusaContainer) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const paymentModule = container.resolve(Modules.PAYMENT)

  const { data: sessions } = await query.graph({
    entity: "payment_session",
    fields: ["id", "data"],
    filters: {
      provider_id: PROVIDER_ID,
      status: "pending",
      created_at: { $gte: new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000) },
    },
    pagination: { take: BATCH_SIZE, order: { created_at: "DESC" } },
  })

  for (const session of sessions) {
    const invoiceNumber = session.data?.invoice_number
    if (typeof invoiceNumber !== "string") {
      continue
    }
    try {
      const result = await paymentModule.getWebhookActionAndData({
        provider: PROVIDER_ID,
        payload: { data: { invoice_number: invoiceNumber }, rawData: "", headers: {} },
      })
      if (result.action !== PaymentActions.SUCCESSFUL || result.data?.session_id !== session.id) {
        continue
      }
      await processPaymentWorkflow(container).run({ input: result })
      logger.info(`PayStation reconcile: completed payment for invoice ${invoiceNumber}`)
    } catch (error) {
      logger.warn(`PayStation reconcile: invoice ${invoiceNumber} failed: ${(error as Error).message}`)
    }
  }
}

export const config = {
  name: "reconcile-paystation-payments",
  schedule: "*/5 * * * *",
}
