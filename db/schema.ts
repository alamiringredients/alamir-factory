import {sqliteTable,text,integer} from 'drizzle-orm/sqlite-core';
export const ownership=sqliteTable('ownership',{id:integer('id').primaryKey(),userId:text('user_id').notNull()});
export const members=sqliteTable('members',{email:text('email').primaryKey(),role:text('role').notNull()});
export const tickets=sqliteTable('tickets',{id:integer('id').primaryKey({autoIncrement:true}),demo:integer('demo').notNull(),version:integer('version').notNull().default(1),status:text('status').notNull(),data:text('data').notNull(),history:text('history').notNull(),createdAt:text('created_at').notNull()});
export const catalogs=sqliteTable('catalogs',{id:integer('id').primaryKey(),version:integer('version').notNull(),data:text('data').notNull()});
export const productionOrders=sqliteTable('production_orders',{id:integer('id').primaryKey({autoIncrement:true}),demo:integer('demo').notNull(),version:integer('version').notNull().default(1),status:text('status').notNull(),data:text('data').notNull()});
