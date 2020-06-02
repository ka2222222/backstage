/*
 * Copyright 2020 Spotify AB
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import RegisterComponentForm from './RegisterComponentForm';

// TODO(ishmidt): rewrite tests
describe('RegisterComponentForm', () => {
  it('should initially render a disabled button', async () => {
    const rendered = render(<RegisterComponentForm onSubmit={jest.fn()} />);
    expect(
      await rendered.findByText(
        'Enter the full path to the service-info.yaml file in GHE to start tracking your component. It must be in a public repo, on the master branch.',
      ),
    ).toBeInTheDocument();

    const submit = (await rendered.getByRole('button')) as HTMLButtonElement;
    expect(submit.disabled).toBeTruthy();
  });

  it('should enable a submit form when data when component url is set ', async () => {
    const rendered = render(<RegisterComponentForm onSubmit={jest.fn()} />);
    const input = (await rendered.getByRole('textbox')) as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: 'https://example.com/blob/master/service.yaml' },
    });
    const submit = (await rendered.findByText('Submit')) as HTMLButtonElement;

    expect(submit.disabled).toBeFalsy();
  });

  it('should hide input on submission ', async () => {
    const rendered = render(<RegisterComponentForm onSubmit={jest.fn()} />);

    expect(
      await rendered.findByText(
        'Your component is being registered. Please wait.',
      ),
    ).toBeInTheDocument();
  });
});
