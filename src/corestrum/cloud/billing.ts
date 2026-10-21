import Stripe from "stripe";
import type postgres from "postgres";
import { randomUUID, createHash } from "node:crypto";
import { isPlan, PLANS, type Plan } from "../catalog";
export type Account = {
  subject: string;
  workspace: string;
  customer: string | null;
  plan: Plan | null;
  state: string;
  billing_hold: boolean;
  checkout: string | null;
  subscription: string | null;
  payment_intent: string | null;
  paid_until: number | null;
  updates_until: number | null;
};
export type BillingConfig = {
  origin: string;
  prices: Record<Plan, string>;
  environment: "staging" | "production";
  webhookSecret: string;
};
const id = (v: unknown): string | null =>
  typeof v === "string"
    ? v
    : typeof v === "object" && v !== null && "id" in v
      ? String(v.id)
      : null;
export class Billing {
  constructor(
    readonly sql: postgres.Sql,
    readonly stripe: Stripe,
    readonly config: BillingConfig,
  ) {}
  async audit(
    subject: string,
    action: string,
    resource: string,
    db: any = this.sql,
  ) {
    await db`INSERT INTO corestrum_private.audit(subject_hash,action,resource) VALUES(${createHash("sha256").update(subject).digest("hex")},${action},${resource})`;
  }
  async account(subject: string): Promise<Account> {
    await this
      .sql`INSERT INTO corestrum_private.accounts(subject,workspace) VALUES(${subject},${randomUUID()}) ON CONFLICT(subject) DO NOTHING`;
    const row = (
      await this.sql<
        Account[]
      >`SELECT * FROM corestrum_private.accounts WHERE subject=${subject}`
    )[0]!;
    return {
      ...row,
      paid_until: row.paid_until === null ? null : Number(row.paid_until),
      updates_until:
        row.updates_until === null ? null : Number(row.updates_until),
    };
  }
  async checkout(subject: string, plan: Plan) {
    if (!isPlan(plan)) throw new Error("INVALID_PLAN");
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${subject},0))`;
      await tx`INSERT INTO corestrum_private.accounts(subject,workspace) VALUES(${subject},${randomUUID()}) ON CONFLICT(subject) DO NOTHING`;
      let a = (
        await tx<
          Account[]
        >`SELECT * FROM corestrum_private.accounts WHERE subject=${subject}`
      )[0]!;
      if (a.billing_hold) throw new Error("BILLING_REVIEW_REQUIRED");
      if (await this.complimentary(a, tx)) throw new Error("ALREADY_LICENSED");
      if (a.state === "active") throw new Error("ALREADY_LICENSED");
      if (a.checkout) {
        const old = await this.stripe.checkout.sessions.retrieve(a.checkout);
        if (old.status === "open" && old.url) {
          if (a.plan === plan) return { url: old.url };
          await this.stripe.checkout.sessions.expire(old.id);
        }
        if (old.status === "complete" && a.state === "unpaid")
          throw new Error("PAYMENT_RECONCILIATION_PENDING");
      }
      if (!a.customer) {
        const customer = await this.stripe.customers.create(
          { description: "Corestrum software account" },
          { idempotencyKey: `corestrum:${a.workspace}:customer` },
        );
        a = { ...a, customer: customer.id };
        await tx`UPDATE corestrum_private.accounts SET customer=${customer.id} WHERE subject=${subject}`;
      }
      const price = await this.stripe.prices.retrieve(this.config.prices[plan]);
      if (
        price.livemode !== (this.config.environment === "production") ||
        !price.active ||
        price.currency !== "usd" ||
        price.unit_amount !== PLANS[plan].cents ||
        (price.recurring?.interval ?? null) !== PLANS[plan].cadence
      )
        throw new Error("PRICE_CONFIGURATION_MISMATCH");
      const session = await this.stripe.checkout.sessions.create(
        {
          customer: a.customer!,
          mode: plan === "perpetual" ? "payment" : "subscription",
          line_items: [{ price: price.id, quantity: 1 }],
          success_url: this.config.origin + "/?checkout=complete",
          cancel_url: this.config.origin + "/?checkout=cancelled",
          client_reference_id: a.workspace,
          integration_identifier:
            "corestrum_" +
            randomUUID()
              .replace(/[^a-z]/g, "")
              .padEnd(8, "x")
              .slice(0, 8),
        },
        {
          idempotencyKey: `corestrum:${a.workspace}:${a.checkout ?? "first"}:${plan}`,
        },
      );
      if (
        !session.url ||
        new URL(session.url).origin !== "https://checkout.stripe.com"
      )
        throw new Error("CHECKOUT_UNAVAILABLE");
      await tx`UPDATE corestrum_private.accounts SET checkout=${session.id},plan=${plan},updated_at=now() WHERE subject=${subject}`;
      await this.audit(subject, "checkout.created", session.id, tx);
      return { url: session.url };
    });
  }
  async portal(subject: string) {
    const a = await this.account(subject);
    if (await this.complimentary(a)) throw new Error("NO_BILLING_ACCOUNT");
    if (!a.customer) throw new Error("NO_BILLING_ACCOUNT");
    const session = await this.stripe.billingPortal.sessions.create({
      customer: a.customer,
      return_url: this.config.origin + "/",
    });
    return { url: session.url };
  }
  async complimentary(a: Pick<Account, "subject" | "workspace">, db: any = this.sql): Promise<string | null> {
    const rows = await db`SELECT g.id FROM corestrum_private.complimentary_grants g WHERE g.subject=${a.subject} AND g.workspace=${a.workspace}::uuid AND g.environment=${this.config.environment} AND NOT EXISTS (SELECT 1 FROM corestrum_private.complimentary_revocations r WHERE r.grant_id=g.id)`;
    return rows[0]?.id ?? null;
  }
  async reconcile(customer: string, db?: any) {
    if (!db)
      return this.sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${customer},0))`;
        await this.reconcile(customer, tx);
      });
    const a = (
      await db`SELECT * FROM corestrum_private.accounts WHERE customer=${customer}`
    )[0] as Account | undefined;
    if (!a?.checkout || !a.plan) return;
    const session = await this.stripe.checkout.sessions.retrieve(a.checkout);
    if (
      id(session.customer) !== customer ||
      session.client_reference_id !== a.workspace ||
      session.livemode !== (this.config.environment === "production")
    )
      throw new Error("PAYMENT_BINDING_MISMATCH");
    const lines = await this.stripe.checkout.sessions.listLineItems(
      session.id,
      { limit: 2 },
    );
    if (
      lines.data.length !== 1 ||
      id(lines.data[0]!.price) !== this.config.prices[a.plan] ||
      lines.data[0]!.quantity !== 1
    )
      throw new Error("PAYMENT_PRICE_MISMATCH");
    let active = false,
      until: number | null = null,
      updates: number | null = null;
    const subscription = id(session.subscription),
      payment = id(session.payment_intent);
    if (a.plan !== "perpetual" && subscription) {
      const sub = await this.stripe.subscriptions.retrieve(subscription, {
        expand: ["latest_invoice"],
      });
      const invoice = sub.latest_invoice;
      active =
        id(sub.customer) === customer &&
        sub.status === "active" &&
        typeof invoice === "object" &&
        invoice !== null &&
        invoice.status === "paid" &&
        sub.items.data.length === 1 &&
        sub.items.data[0]!.price.id === this.config.prices[a.plan];
      until = active ? sub.items.data[0]!.current_period_end : null;
      updates = until;
    } else if (
      a.plan === "perpetual" &&
      payment &&
      session.payment_status === "paid"
    ) {
      const intent = await this.stripe.paymentIntents.retrieve(payment, {
        expand: ["latest_charge"],
      });
      const charge = intent.latest_charge;
      active =
        id(intent.customer) === customer &&
        intent.status === "succeeded" &&
        typeof charge === "object" &&
        charge !== null &&
        charge.paid &&
        !charge.refunded &&
        !charge.disputed &&
        charge.amount_refunded === 0;
      updates = active ? session.created + 365 * 86400 : null;
    }
    active = active && !a.billing_hold;
    await db`UPDATE corestrum_private.accounts SET state=${active ? "active" : "suspended"},subscription=${subscription},payment_intent=${payment},paid_until=${until},updates_until=${updates},updated_at=now() WHERE subject=${a.subject}`;
    await this.audit(
      a.subject,
      active ? "license.entitled" : "license.suspended",
      session.id,
      db,
    );
  }
  async webhook(body: string, signature: string) {
    const event = await this.stripe.webhooks.constructEventAsync(
      body,
      signature,
      this.config.webhookSecret,
    );
    if (event.livemode !== (this.config.environment === "production"))
      throw new Error("WRONG_STRIPE_ENVIRONMENT");
    const object = event.data.object as unknown as Record<string, unknown>;
    let customer = id(object.customer);
    if (event.type.startsWith("charge.dispute.")) {
      const charge = await this.stripe.charges.retrieve(String(object.charge));
      customer = id(charge.customer);
    }
    if (
      !/^(checkout\.session\.(completed|async_payment_succeeded|async_payment_failed)|customer\.subscription\.|invoice\.(paid|payment_failed)|charge\.(refunded|dispute\.))/.test(
        event.type,
      )
    )
      return { received: true };
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${customer ?? event.id},0))`;
      if (
        (await tx`SELECT id FROM corestrum_private.events WHERE id=${event.id}`)
          .length
      )
        return;
      if (customer) {
        if (
          event.type === "charge.refunded" ||
          event.type.startsWith("charge.dispute.")
        ) {
          await tx`UPDATE corestrum_private.accounts SET billing_hold=true,state='suspended',updated_at=now() WHERE customer=${customer}`;
        }
        await this.reconcile(customer, tx);
      }
      await tx`INSERT INTO corestrum_private.events(id,kind) VALUES(${event.id},${event.type}) ON CONFLICT DO NOTHING`;
    });
    return { received: true };
  }
}
