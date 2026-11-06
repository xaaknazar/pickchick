import { Body, Controller, Get, Headers, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  CourierIncidentListQuerySchema,
  CourierIncidentListSchema,
  CourierIncidentRequestSchema,
  CourierIncidentSchema,
  FulfillmentLayoutSchema,
  KdsBreadingSchema,
  UuidSchema,
} from '@pickchick/contracts';
import { transaction } from '@pickchick/database';
import { EdgeFulfillment } from '@pickchick/edge-fulfillment';
import { authenticateManagedTerminal } from '@pickchick/local-orders';
import { RESOURCE, Resources } from '@pickchick/platform';
import {
  boundFulfillmentSession,
  fail,
  input,
  output,
  pageLimit,
  runFulfillment,
} from './fulfillment-controller.js';
import type { RequestHeaders } from './fulfillment-controller.js';

/**
 * Cutover KDS views of the kitchen LAN (contracts section 5.4). Same session checks as the
 * kitchen API. While the edge KDS layout is off, GET layout answers {enabled:false} (the client
 * keeps today's screen); GET kds/breading and the courier incidents answer 404.
 */
@Controller('edge/v1/fulfillment')
export class KdsController {
  private readonly repository: EdgeFulfillment;
  constructor(@Inject(RESOURCE) private readonly resources: Resources) {
    this.repository = new EdgeFulfillment(resources.pool);
  }
  private get branchId() {
    return this.resources.config.branchId!;
  }
  @Get('layout')
  layout(@Headers() headers: RequestHeaders, @Query() query: unknown) {
    return runFulfillment(this.resources, headers, async (auth) => {
      input(z.strictObject({}), query);
      // A managed screen opens only stations of its own mode (prep or assembly).
      const terminal = auth.terminal
        ? await transaction(this.resources.pool, (client) =>
            authenticateManagedTerminal(client, this.branchId, auth.terminal!),
          )
        : null;
      const mode =
        terminal?.mode === 'prep' || terminal?.mode === 'assembly' ? terminal.mode : undefined;
      const result = await this.repository.readLayout(this.branchId, auth, mode);
      await boundFulfillmentSession(this.resources, headers);
      return output(FulfillmentLayoutSchema, result);
    });
  }
  @Get('kds/breading')
  breading(@Headers() headers: RequestHeaders, @Query() query: unknown) {
    return runFulfillment(this.resources, headers, async (auth) => {
      const parsed = input(z.strictObject({ limit: pageLimit }), query);
      const layout = await this.repository.readLayout(this.branchId, auth);
      const station = layout.enabled
        ? layout.stations.find((s) => s.function === 'breading')
        : undefined;
      if (!station) return fail(404, 'NOT_FOUND');
      // Station 6: a prep screen of a kitchen login with access to the breading station.
      await boundFulfillmentSession(this.resources, headers, true, station.id);
      const result = await this.repository.readBreading(this.branchId, auth, parsed);
      await boundFulfillmentSession(this.resources, headers, true, station.id);
      return output(KdsBreadingSchema, result);
    });
  }
  /**
   * Courier protocol refusal (Аг9) from the courier counter: Idempotency-Key = incident id; the
   * same request replays the stored record (201 again), another one under that key is 409.
   */
  @Post('incidents')
  @HttpCode(201)
  recordIncident(@Headers() headers: RequestHeaders, @Body() body: unknown) {
    return runFulfillment(this.resources, headers, async (auth) => {
      const request = input(CourierIncidentRequestSchema, body);
      const incidentId = input(UuidSchema, headers['idempotency-key']);
      // Screens 3 and 2 record refusals: a managed screen must be an assembly screen.
      if (auth.terminal) {
        const terminal = await transaction(this.resources.pool, (client) =>
          authenticateManagedTerminal(client, this.branchId, auth.terminal!),
        );
        if (terminal && terminal.mode !== 'assembly') fail(403, 'FORBIDDEN');
      }
      return output(
        CourierIncidentSchema,
        await this.repository.recordIncident(this.branchId, auth, incidentId, request),
      );
    });
  }
  /** "Менеджер вызван" banner (scope=open) and the journal of the day (scope=today). */
  @Get('incidents')
  incidents(@Headers() headers: RequestHeaders, @Query() query: unknown) {
    return runFulfillment(this.resources, headers, async (auth) => {
      const parsed = input(CourierIncidentListQuerySchema, query);
      const result = await this.repository.listIncidents(this.branchId, auth, parsed);
      await boundFulfillmentSession(this.resources, headers);
      return output(CourierIncidentListSchema, result);
    });
  }
}
