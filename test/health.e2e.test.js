import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { AppModule } from '../dist/app.module.js';

test('GET /health returns HTTP 200 and status ok through Nest/Fastify', async (t) => {
  const app = await NestFactory.create(AppModule, new FastifyAdapter(), {
    logger: false,
  });
  t.after(() => app.close());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  assert.equal(app.getHttpAdapter().getType(), 'fastify');
  const response = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ok' });
});
