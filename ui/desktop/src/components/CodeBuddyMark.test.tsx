import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CodeBuddyMark } from './CodeBuddyMark';
import GooseLogo from './GooseLogo';
import { Goose } from './icons/Goose';
import mark from '../images/mark.png';
import mark2x from '../images/mark@2x.png';

describe('CodeBuddy brand artwork', () => {
  it('uses one artwork for the mark and legacy logo entry points', () => {
    const { container } = render(
      <>
        <CodeBuddyMark className="size-5" />
        <GooseLogo size="small" />
        <Goose />
      </>
    );
    const images = container.querySelectorAll('img');
    expect(images).toHaveLength(3);
    for (const image of images) {
      expect(image).toHaveAttribute('src', mark);
      expect(image).toHaveAttribute('srcset', `${mark} 1x, ${mark2x} 2x`);
      expect(image).toHaveAttribute('alt', '');
    }
    expect(images[0]).toHaveClass('size-5');
    expect(container.querySelector('svg')).toBeNull();
  });
});
