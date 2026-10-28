import {
  AbstractPaymentProvider,
  BigNumber,
  MedusaError,
  PaymentActions,
  PaymentSessionStatus,
} from "@medusajs/framework/utils"
import type {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  BigNumberInput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  Logger,
  PaymentProviderContext,
  ProviderWebhookPayload,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  WebhookActionResult,
} from "@medusajs/framework/types"

type PayStationOptions = {
  merchant_id: string
  password: string
  sandbox?: boolean
  // Where PayStation sends the shopper after checkout. A storefront may pass its
  // own data.callback_url only if that URL's origin is listed here.
  callback_url?: string
  allowed_callback_origins?: string[]
  // true: the customer pays the gateway charge, false: the merchant does.
  pay_with_charge?: boolean
}

type InjectedDependencies = {
  logger: Logger
}

type PayStationTransaction = {
  invoice_number: string
  trx_status: string
  trx_id?: string
  request_amount?: string
  payment_amount?: string
  payment_method?: string
  order_date_time?: string
}

type PayStationResponse = {
  status_code?: string
  status?: string
  message?: string
  payment_url?: string
  data?: PayStationTransaction
}

const SANDBOX_URL = "https://sandbox.paystation.com.bd"
const LIVE_URL = "https://api.paystation.com.bd"
const NOT_FOUND = "2001"
const REQUEST_TIMEOUT_MS = 30000

// Invoice numbers are the Medusa payment session id, plus "-<n>" when the
// amount changes and a new invoice is needed (PayStation invoices are fixed).
const toSessionId = (invoiceNumber: string) => invoiceNumber.split("-")[0]

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined

// The docs say "success"/"Success", but the sandbox reports paid invoices as
// "successful", so normalise every spelling to one status.
const normaliseStatus = (status: string | undefined) => {
  const value = status?.trim().toLowerCase()
  if (value === "success" || value === "successful") {
    return "success"
  }
  if (value === "cancelled" || value === "canceled") {
    return "canceled"
  }
  return value
}

class PayStationProviderService extends AbstractPaymentProvider<PayStationOptions> {
  static identifier = "paystation"

  protected logger_: Logger
  protected options_: PayStationOptions

  static validateOptions(options: Record<string, unknown>) {
    if (!text(options.merchant_id) || !text(options.password)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "PayStation requires the merchant_id and password options"
      )
    }
  }

  constructor(container: InjectedDependencies, options: PayStationOptions) {
    super(container, options)
    this.logger_ = container.logger
    this.options_ = options
  }

  private get baseUrl() {
    return this.options_.sandbox ? SANDBOX_URL : LIVE_URL
  }

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    const sessionId = text(input.data?.session_id) ?? input.context?.idempotency_key
    if (!sessionId) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "PayStation needs a payment session id")
    }
    const data = await this.createInvoice(sessionId, sessionId, input)
    return { id: data.invoice_number as string, status: PaymentSessionStatus.PENDING, data }
  }

  // Medusa calls this with the stored session data (storefront input under
  // data.client). A new invoice is only needed when the amount or currency moved.
  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    const stored = input.data ?? {}
    const sessionId = text(stored.session_id) ?? input.context?.idempotency_key
    if (!sessionId) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "PayStation needs a payment session id")
    }
    const amount = new BigNumber(input.amount).numeric
    if (
      text(stored.invoice_number) &&
      Math.abs(amount - Number(stored.amount)) <= 0.01 &&
      stored.currency_code === input.currency_code.toLowerCase()
    ) {
      return { data: stored }
    }
    const attempt = Number(stored.attempt ?? 1) + 1
    const data = await this.createInvoice(sessionId, `${sessionId}-${attempt}`, input)
    return { status: PaymentSessionStatus.PENDING, data: { ...stored, ...data, attempt } }
  }

  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    return this.checkTransaction(input.data)
  }

  async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    return this.checkTransaction(input.data)
  }

  async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    const { data } = await this.checkTransaction(input.data)
    return { data }
  }

  // PayStation sells immediately: authorizePayment reports "captured" once the
  // transaction succeeds, so there is nothing left to capture.
  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
    return { data: input.data }
  }

  // PayStation has no cancel API; unpaid checkout links simply expire.
  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    return { data: input.data }
  }

  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    return { data: input.data }
  }

  async refundPayment(_input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      "PayStation has no refund API. Refund the customer from the PayStation merchant panel."
    )
  }

  // The IPN is an unauthenticated POST, so its body is only used to find the
  // invoice; the outcome always comes from PayStation's transaction status API.
  async getWebhookActionAndData(
    payload: ProviderWebhookPayload["payload"]
  ): Promise<WebhookActionResult> {
    const invoiceNumber = text((payload.data as Record<string, unknown>)?.invoice_number)
    if (!invoiceNumber?.startsWith("payses_")) {
      return { action: PaymentActions.NOT_SUPPORTED }
    }

    const transaction = await this.fetchTransaction(invoiceNumber)
    if (!transaction || normaliseStatus(transaction.trx_status) !== "success") {
      return { action: PaymentActions.NOT_SUPPORTED }
    }

    return {
      action: PaymentActions.SUCCESSFUL,
      data: {
        session_id: toSessionId(invoiceNumber),
        amount: new BigNumber(Number(transaction.request_amount ?? transaction.payment_amount)),
      },
    }
  }

  private async createInvoice(
    sessionId: string,
    invoiceNumber: string,
    input: { amount: BigNumberInput; currency_code: string; data?: Record<string, unknown>; context?: PaymentProviderContext }
  ) {
    const amount = new BigNumber(input.amount).numeric
    if (!(amount > 0)) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "PayStation payment amount must be greater than 0")
    }

    const currencyCode = input.currency_code.toLowerCase()
    if (currencyCode !== "bdt") {
      if (!this.options_.sandbox) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `PayStation settles in BDT; set the region currency to BDT (got ${currencyCode.toUpperCase()})`
        )
      }
      this.logger_.warn(
        `PayStation sandbox: charging ${currencyCode.toUpperCase()} amount ${amount} as-is; live mode only accepts BDT`
      )
    }

    // Storefront data is untrusted: it may only supply contact details and an
    // allow-listed callback URL. Amount and invoice number come from Medusa.
    const nested = input.data?.client
    const client = {
      ...(input.data ?? {}),
      ...(nested && typeof nested === "object" ? (nested as Record<string, unknown>) : {}),
    }
    const customer = input.context?.customer
    const billing = customer?.billing_address
    const email = text(client.cust_email) ?? text(customer?.email)
    const phone = text(client.cust_phone) ?? text(customer?.phone) ?? text(billing?.phone)
    const name =
      text(client.cust_name) ??
      text([customer?.first_name, customer?.last_name].filter(Boolean).join(" ")) ??
      email
    const address =
      text(client.cust_address) ??
      text([billing?.address_1, billing?.city, billing?.postal_code].filter(Boolean).join(", "))

    if (!email || !name) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "PayStation needs the customer's email address")
    }
    if (!phone) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "PayStation needs the customer's phone number: send it as data.cust_phone when creating the payment session"
      )
    }

    const callbackUrl = this.resolveCallbackUrl(client.callback_url)
    const body = new URLSearchParams({
      merchantId: this.options_.merchant_id,
      password: this.options_.password,
      invoice_number: invoiceNumber,
      currency: currencyCode.toUpperCase(),
      payment_amount: Number.isInteger(amount) ? String(amount) : amount.toFixed(2),
      pay_with_charge: this.options_.pay_with_charge ? "1" : "0",
      reference: sessionId,
      cust_name: name,
      cust_phone: phone,
      cust_email: email,
      callback_url: callbackUrl,
    })
    if (address) {
      body.set("cust_address", address)
    }

    const response = await this.request("/initiate-payment", body)
    if (response.status_code !== "200" || !response.payment_url) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `PayStation could not create the payment: ${response.message ?? "unknown error"}`
      )
    }

    return {
      session_id: sessionId,
      invoice_number: invoiceNumber,
      payment_url: response.payment_url,
      amount,
      currency_code: currencyCode,
      callback_url: callbackUrl,
      cust_name: name,
      cust_phone: phone,
      cust_email: email,
      cust_address: address ?? null,
    }
  }

  private async checkTransaction(data: Record<string, unknown> | undefined) {
    const invoiceNumber = text(data?.invoice_number)
    if (!invoiceNumber) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "PayStation session has no invoice number")
    }

    const transaction = await this.fetchTransaction(invoiceNumber)
    const status = this.toSessionStatus(transaction, Number(data?.amount))
    const details = transaction
      ? {
          trx_status: transaction.trx_status,
          trx_id: transaction.trx_id || undefined,
          payment_method: transaction.payment_method || undefined,
          paid_amount: transaction.payment_amount,
        }
      : {}

    return { status, data: { ...data, ...details } }
  }

  private toSessionStatus(transaction: PayStationTransaction | null, expectedAmount: number) {
    switch (normaliseStatus(transaction?.trx_status)) {
      case "success": {
        const requested = Number(transaction?.request_amount ?? transaction?.payment_amount)
        if (!Number.isFinite(expectedAmount) || Math.abs(requested - expectedAmount) > 0.01) {
          this.logger_.error(
            `PayStation invoice ${transaction?.invoice_number}: paid amount ${requested} does not match ${expectedAmount}`
          )
          return PaymentSessionStatus.ERROR
        }
        return PaymentSessionStatus.CAPTURED
      }
      case "processing":
        return PaymentSessionStatus.PENDING
      case "failed":
        return PaymentSessionStatus.ERROR
      case "refund":
      case "canceled":
        return PaymentSessionStatus.CANCELED
      default:
        return transaction ? PaymentSessionStatus.ERROR : PaymentSessionStatus.PENDING
    }
  }

  private async fetchTransaction(invoiceNumber: string): Promise<PayStationTransaction | null> {
    const response = await this.request(
      "/transaction-status",
      new URLSearchParams({ invoice_number: invoiceNumber }),
      { merchantId: this.options_.merchant_id }
    )
    if (response.status_code === NOT_FOUND) {
      return null
    }
    if (response.status_code !== "200" || !response.data) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `PayStation transaction lookup failed: ${response.message ?? "unknown error"}`
      )
    }
    return response.data
  }

  private resolveCallbackUrl(requested: unknown) {
    const candidate = text(requested)
    if (candidate && candidate !== this.options_.callback_url) {
      let url: URL
      try {
        url = new URL(candidate)
      } catch {
        throw new MedusaError(MedusaError.Types.INVALID_DATA, "data.callback_url is not a valid URL")
      }
      if (!this.options_.allowed_callback_origins?.includes(url.origin)) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `data.callback_url origin ${url.origin} is not allowed; add it to PAYSTATION_CALLBACK_ORIGINS`
        )
      }
      return url.toString()
    }
    if (!this.options_.callback_url) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Set PAYSTATION_CALLBACK_URL or pass an allowed data.callback_url"
      )
    }
    return this.options_.callback_url
  }

  private async request(
    path: string,
    body: URLSearchParams,
    headers: Record<string, string> = {}
  ): Promise<PayStationResponse> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { Accept: "application/json", ...headers },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `PayStation request to ${path} failed: ${(error as Error).message}`
      )
    }

    const raw = await response.text()
    try {
      return JSON.parse(raw) as PayStationResponse
    } catch {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `PayStation ${path} returned HTTP ${response.status} with a non-JSON body`
      )
    }
  }
}

export default PayStationProviderService
