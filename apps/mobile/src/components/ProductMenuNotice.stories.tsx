import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { useState } from 'react';
import { ProductMenuNotice } from './ProductMenuNotice';
import { Button } from './UI';
import type { Product } from '../model';
function PublicationPreview() {
  const [published, setPublished] = useState(false);
  const product: Product = {
    id: 'combo',
    name: 'Pick Combo',
    description: '',
    category: 'Комбо',
    image: 0,
    source: 'server',
    priceMinor: published ? '449000' : '419000',
    catalogVersion: published ? 'published:synthetic:2' : 'published:synthetic:1',
  };
  return (
    <>
      <ProductMenuNotice product={product} selections={[]} />
      <Button
        title="Опубликовать новую цену"
        onPress={() => setPublished(true)}
        disabled={published}
      />
    </>
  );
}
const meta = {
  title: 'Mobile/ProductMenuNotice',
  component: ProductMenuNotice,
  tags: ['autodocs'],
  args: {
    product: {
      id: 'combo',
      name: 'Pick Combo',
      description: '',
      category: 'Комбо',
      image: 0,
      source: 'server',
      priceMinor: '419000',
    },
    selections: [],
  },
  render: () => <PublicationPreview />,
} satisfies Meta<typeof ProductMenuNotice>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Publication: Story = {};
