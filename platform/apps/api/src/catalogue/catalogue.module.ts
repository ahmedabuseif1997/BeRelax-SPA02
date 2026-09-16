import { Module } from '@nestjs/common';
import {
  RoomsController,
  ServiceCategoriesController,
  ServicesController,
} from './catalogue.controller';
import { CatalogueService } from './catalogue.service';

/**
 * Three route prefixes, one module: /services, /service-categories and /rooms
 * are the same thing from three angles — what is sold, how it is grouped and
 * where it happens — and they are edited in one sitting.
 */
@Module({
  controllers: [ServicesController, ServiceCategoriesController, RoomsController],
  providers: [CatalogueService],
  exports: [CatalogueService],
})
export class CatalogueModule {}
