import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import {
  FulfillmentActionSchema,
  FulfillmentConfigSchema,
  FulfillmentDisplaySchema,
  FulfillmentKitchenOrderSchema,
  FulfillmentKitchenSchema,
  FulfillmentModifierSchema,
  FulfillmentOrderSchema,
  FulfillmentStationsSchema,
  FulfillmentSummarySchema,
  UuidSchema,
} from '@pickchick/contracts';
import { transaction } from '@pickchick/database';
import { EdgeFulfillment, FulfillmentError } from '@pickchick/edge-fulfillment';
import {
  authenticateStaff,
  authenticateManagedTerminal,
  authenticateTerminal,
  edgeDeviceAccessEnabled,
  OrderError,
  orderErrorStatus,
} from '@pickchick/local-orders';
import type { StaffAuth } from '@pickchick/local-orders';
import { RESOURCE, Resources } from '@pickchick/platform';

type RequestHeaders = Record<string, string | undefined>;
const pageLimit = z
  .string()
  .regex(/^(?:[1-9][0-9]?|100)$/)
  .transform(Number)
  .default(50);
const kitchenQuery = z.strictObject({
  stationId: z.uuid().optional(),
  afterOrderId: z.uuid().optional(),
  limit: pageLimit,
});
const orderQuery = z.strictObject({ stationId: z.uuid().optional() });
const displayQuery = z.strictObject({
  afterNumber: z
    .string()
    .regex(/^(?:0|[1-9][0-9]{0,18})$/)
    .refine(
      (value) => /^(?:0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n,
    )
    .default('0'),
  limit: pageLimit,
});
const fail = (status: number, code: string): never => {
  throw new HttpException({ code }, status);
};
function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  return result.success ? result.data : fail(400, 'INVALID_REQUEST');
}
function output<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.parse(value);
  // Domain pages budget 2 MiB of items; leave room for the envelope and one expanded order.
  if (Buffer.byteLength(JSON.stringify(result)) > 3 * 1024 * 1024) fail(503, 'SERVICE_UNAVAILABLE');
  return result;
}
type Summary = Awaited<ReturnType<EdgeFulfillment['act']>>;
type Order = Awaited<ReturnType<EdgeFulfillment['readOrder']>>;
function summary(row: Summary) {
  return output(FulfillmentSummarySchema, {
    orderId: row.orderId,
    branchId: row.branchId,
    version: row.version,
    state: row.state,
    displayNumber: row.displayNumber,
    routingVersion: row.routingVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}
function kitchenOrder(
  row: Pick<Order, keyof Summary | 'channel' | 'serviceMode' | 'tasks' | 'kitchenComment'>,
) {
  return output(FulfillmentKitchenOrderSchema, {
    ...summary(row),
    assemblyStationId: row.assemblyStationId,
    channel: row.channel,
    serviceMode: row.serviceMode,
    ...(row.kitchenComment ? { kitchenComment: row.kitchenComment } : {}),
    tasks: row.tasks.map((task) => ({
      taskId: task.id,
      stationId: task.station_id,
      version: task.version,
      state: task.state,
      kind: task.kind,
      details: {
        lineId: task.details.lineId,
        productId: task.details.productId,
        title: task.details.title,
        parentTitle: task.details.parentTitle,
        description: task.details.description,
        quantity: task.details.quantity,
        // Discard pricing, passthrough metadata and any accidental private fields.
        modifiers: task.details.modifiers.map((modifier) =>
          FulfillmentModifierSchema.strip().parse(modifier),
        ),
      },
    })),
  });
}

/** LAN staff adapter only. No cloud admission, setup, payment or outbox routes. */
@Controller('edge/v1/fulfillment')
export class FulfillmentController {
  private readonly repository: EdgeFulfillment;
  constructor(@Inject(RESOURCE) private readonly resources: Resources) {
    this.repository = new EdgeFulfillment(resources.pool);
  }
  private get branchId() {
    return this.resources.config.branchId!;
  }
  private credentials(headers: RequestHeaders): StaffAuth {
    return {
      sessionId: headers['x-staff-session-id'] ?? '',
      token: headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '',
      ...(edgeDeviceAccessEnabled()
        ? { terminal: { id: headers['x-terminal-id'] ?? '', key: headers['x-terminal-key'] ?? '' } }
        : {}),
    };
  }
  private async boundSession(headers: RequestHeaders, requireStation = false, stationId?: string) {
    const auth = this.credentials(headers);
    return transaction(this.resources.pool, async (client) => {
      const actor = await authenticateStaff(client, this.branchId, auth);
      if (
        !UuidSchema.safeParse(headers['x-terminal-id']).success ||
        actor.terminal_id !== headers['x-terminal-id']
      )
        fail(403, 'FORBIDDEN');
      if (!['kitchen', 'shift_manager'].includes(actor.role)) fail(403, 'FORBIDDEN');
      const terminal = auth.terminal
        ? await authenticateManagedTerminal(client, this.branchId, auth.terminal)
        : null;
      if (terminal?.mode === 'display') fail(403, 'FORBIDDEN');
      const config = await client.query(
        'SELECT 1 FROM fulfillment_config WHERE branch_id=$1 AND device_id=$2 FOR SHARE',
        [this.branchId, this.resources.config.edgeDeviceId],
      );
      if (!config.rowCount) fail(503, 'SERVICE_UNAVAILABLE');
      if (requireStation && (actor.role === 'kitchen' || terminal) && !stationId)
        fail(400, 'INVALID_REQUEST');
      if (stationId) {
        const station = await client.query(
          'SELECT kind FROM fulfillment_stations WHERE branch_id=$1 AND id=$2 FOR SHARE',
          [this.branchId, stationId],
        );
        if (!station.rowCount) fail(403, 'FORBIDDEN');
        if (terminal && station.rows[0].kind !== terminal.mode) fail(403, 'FORBIDDEN');
        if (actor.role !== 'shift_manager') {
          const grant = await client.query(
            'SELECT 1 FROM fulfillment_station_grants WHERE branch_id=$1 AND staff_id=$2 AND station_id=$3 FOR SHARE',
            [this.branchId, actor.staff_id, stationId],
          );
          if (!grant.rowCount) fail(403, 'FORBIDDEN');
        }
      }

      return actor;
    });
  }
  private async run<T>(headers: RequestHeaders, action: (auth: StaffAuth) => Promise<T>) {
    if (!this.resources.config.edgeFulfillmentEnabled) fail(404, 'NOT_FOUND');
    try {
      await this.boundSession(headers);
      return await action(this.credentials(headers));
    } catch (error) {
      if (error instanceof OrderError)
        throw new HttpException({ code: error.code }, orderErrorStatus[error.code]);
      if (error instanceof FulfillmentError) {
        if (error.code === 'INVALID') fail(400, 'INVALID_REQUEST');
        if (error.code === 'FORBIDDEN') fail(403, 'FORBIDDEN');
        if (error.code === 'NOT_FOUND') fail(404, 'NOT_FOUND');
        fail(409, 'CONFLICT');
      }
      throw error;
    }
  }
  @Get('config')
  config() {
    return output(FulfillmentConfigSchema, {
      enabled: this.resources.config.edgeFulfillmentEnabled === true,
      ...(this.resources.config.edgeFulfillmentEnabled ? { wholeTicketActions: true } : {}),
    });
  }
  @Get('stations')
  stations(@Headers() headers: RequestHeaders, @Query() query: unknown) {
    return this.run(headers, async (auth) => {
      input(z.strictObject({}), query);
      const result = await transaction(this.resources.pool, async (client) => {
        const actor = await authenticateStaff(client, this.branchId, auth);
        const rows = await client.query<{ id: string; kind: string; name: string }>(
          `SELECT s.id,s.kind,s.name FROM fulfillment_stations s WHERE s.branch_id=$1
           AND ($2='shift_manager' OR EXISTS(SELECT 1 FROM fulfillment_station_grants g
             WHERE g.branch_id=s.branch_id AND g.station_id=s.id AND g.staff_id=$3)) ORDER BY s.id`,
          [this.branchId, actor.role, actor.staff_id],
        );
        const terminal = auth.terminal
          ? await authenticateManagedTerminal(client, this.branchId, auth.terminal)
          : null;
        return {
          branchId: this.branchId,
          items: terminal ? rows.rows.filter((row) => row.kind === terminal.mode) : rows.rows,
        };
      });
      await this.boundSession(headers);
      return output(FulfillmentStationsSchema, result);
    });
  }
  @Get('kitchen')
  kitchen(@Headers() headers: RequestHeaders, @Query() query: unknown) {
    return this.run(headers, async (auth) => {
      const parsed = input(kitchenQuery, query);
      await this.boundSession(headers, true, parsed.stationId);
      const result = await this.repository.listKitchen(this.branchId, auth, parsed);
      await this.boundSession(headers, true, parsed.stationId);
      return output(FulfillmentKitchenSchema, {
        items: result.items.map(kitchenOrder),
        nextAfterOrderId: result.nextAfterOrderId,
      });
    });
  }
  @Get('orders/:orderId')
  order(@Headers() headers: RequestHeaders, @Param('orderId') id: string, @Query() query: unknown) {
    return this.run(headers, async (auth) => {
      const parsed = input(orderQuery, query);
      await this.boundSession(headers, true, parsed.stationId);
      const row = await this.repository.readOrder(
        this.branchId,
        auth,
        input(UuidSchema, id),
        parsed,
      );
      await this.boundSession(headers, true, parsed.stationId);
      return output(FulfillmentOrderSchema, {
        ...kitchenOrder(row),
        cancellationReason: row.cancellationReason,
        inventoryDisposition: row.inventoryDisposition,
      });
    });
  }
  @Post('orders/:orderId/actions')
  @HttpCode(200)
  action(@Headers() headers: RequestHeaders, @Param('orderId') id: string, @Body() body: unknown) {
    return this.run(headers, async (auth) => {
      const action = input(FulfillmentActionSchema, body);
      const orderId = input(UuidSchema, id);
      if (auth.terminal)
        await transaction(this.resources.pool, async (client) => {
          const terminal = await authenticateManagedTerminal(client, this.branchId, auth.terminal!);
          if (!terminal) return;
          if (terminal.mode === 'display' || action.action === 'confirm_cancel')
            fail(403, 'FORBIDDEN');
          if ('taskId' in action) {
            const station = (
              await client.query(
                `SELECT s.kind FROM fulfillment_tasks t
            JOIN fulfillment_stations s ON s.id=t.station_id AND s.branch_id=t.branch_id
            WHERE t.id=$1 AND t.order_id=$2 AND t.branch_id=$3`,
                [action.taskId, orderId, this.branchId],
              )
            ).rows[0];
            if (!station || station.kind !== terminal.mode) fail(403, 'FORBIDDEN');
          } else if ('stationId' in action) {
            const station = (
              await client.query(
                'SELECT kind FROM fulfillment_stations WHERE id=$1 AND branch_id=$2',
                [action.stationId, this.branchId],
              )
            ).rows[0];
            if (!station || station.kind !== terminal.mode) fail(403, 'FORBIDDEN');
          } else if (terminal.mode !== 'assembly') fail(403, 'FORBIDDEN');
        });
      return summary(
        await this.repository.act(this.branchId, auth, {
          ...action,
          orderId,
          commandId: input(UuidSchema, headers['idempotency-key']),
        }),
      );
    });
  }
  @Get('display')
  async display(@Headers() headers: RequestHeaders, @Query() query: unknown) {
    if (edgeDeviceAccessEnabled() && headers['x-terminal-key']) {
      if (!this.resources.config.edgeFulfillmentEnabled) fail(404, 'NOT_FOUND');
      try {
        const check = () =>
          transaction(this.resources.pool, async (client) => {
            const terminal = await authenticateTerminal(client, this.branchId, {
              id: headers['x-terminal-id'] ?? '',
              key: headers['x-terminal-key'] ?? '',
            });
            if (terminal.mode !== 'display') fail(403, 'FORBIDDEN');
          });
        await check();
        const result = await this.repository.readDisplay(this.branchId, input(displayQuery, query));
        await check();
        return output(FulfillmentDisplaySchema, result);
      } catch (error) {
        if (error instanceof OrderError)
          throw new HttpException({ code: error.code }, orderErrorStatus[error.code]);
        if (error instanceof HttpException) throw error;
        throw new HttpException({ code: 'SERVICE_UNAVAILABLE' }, 503);
      }
    }
    return this.run(headers, async () => {
      const result = await this.repository.readDisplay(this.branchId, input(displayQuery, query));
      await this.boundSession(headers);
      return output(FulfillmentDisplaySchema, result);
    });
  }
}
