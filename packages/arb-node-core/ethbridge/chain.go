/*
 * Copyright 2019-2020, Offchain Labs, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package ethbridge

import (
	"context"
	"time"

	"github.com/pkg/errors"

	"github.com/ethereum/go-ethereum"
	ethcommon "github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"

	"github.com/offchainlabs/arbitrum/packages/arb-util/common"
	"github.com/offchainlabs/arbitrum/packages/arb-util/ethutils"
)

type ArbAddresses struct {
	ArbFactory string `json:"ArbFactory"`
}

var parityErr = "Block information is incomplete while ancient block sync is still in progress, before it's finished we can't determine the existence of requested item."
var parityErr2 = "missing required field 'transactionHash' for Log"

func (a ArbAddresses) ArbFactoryAddress() common.Address {
	return common.NewAddressFromEth(ethcommon.HexToAddress(a.ArbFactory))
}

// RBF = Replace By Fee
const rbfInterval time.Duration = time.Minute * 5

func waitForReceiptWithResultsSimpleInternal(ctx context.Context, client ethutils.ReceiptFetcher, txHash ethcommon.Hash, attemptRbf func() (ethcommon.Hash, error)) (*types.Receipt, error) {
	lastRbf := time.Now()
	for {
		select {
		case <-time.After(time.Second):
			if attemptRbf != nil && time.Since(lastRbf) >= rbfInterval {
				var err error
				txHash, err = attemptRbf()
				if err == nil {
					lastRbf = time.Now()
				} else {
					logger.Warn().Err(err).Msg("failed to replace by fee")
				}
			}
			receipt, err := client.TransactionReceipt(ctx, txHash)
			if receipt == nil && err == nil {
				continue
			}
			if err != nil {
				if err.Error() == ethereum.NotFound.Error() || err.Error() == parityErr {
					continue
				}

				if err.Error() == parityErr2 {
					logger.Warn().Err(err).Hex("tx", txHash.Bytes()).Msg("Issue getting receipt")
					continue
				}
				logger.Error().Err(err).Hex("tx", txHash.Bytes()).Msg("Issue getting receipt")
				return nil, errors.WithStack(err)
			}
			return receipt, nil
		case <-ctx.Done():
			return nil, errors.Errorf("receipt not found")
		}
	}
}

func WaitForReceiptWithResultsSimple(ctx context.Context, client ethutils.ReceiptFetcher, txHash ethcommon.Hash) (*types.Receipt, error) {
	return waitForReceiptWithResultsSimpleInternal(ctx, client, txHash, nil)
}

func WaitForReceiptWithResultsAndReplaceByFee(ctx context.Context, client ethutils.EthClient, from ethcommon.Address, tx *types.Transaction, methodName string, auth *TransactAuth) (*types.Receipt, error) {
	var attemptRbf func() (ethcommon.Hash, error)
	if auth != nil {
		attemptRbf = func() (ethcommon.Hash, error) {
			auth, err := auth.getAuth(ctx)
			if err != nil {
				return ethcommon.Hash{}, err
			}
			if auth.GasPrice.Cmp(tx.GasPrice()) <= 0 {
				return tx.Hash(), nil
			}
			legacyTx := &types.LegacyTx{
				Nonce:    tx.Nonce(),
				GasPrice: auth.GasPrice,
				Gas:      tx.Gas(),
				To:       tx.To(),
				Value:    tx.Value(),
				Data:     tx.Data(),
			}
			newTx, err := auth.Signer(auth.From, types.NewTx(legacyTx))
			if err != nil {
				return ethcommon.Hash{}, err
			}
			err = client.SendTransaction(ctx, tx)
			if err != nil {
				return ethcommon.Hash{}, err
			}
			*tx = *newTx
			return newTx.Hash(), nil
		}
	}
	receipt, err := waitForReceiptWithResultsSimpleInternal(ctx, client, tx.Hash(), attemptRbf)
	if err != nil {
		logger.Warn().Err(err).Hex("tx", tx.Hash().Bytes()).Msg("error while waiting for transaction receipt")
		return nil, errors.WithStack(err)
	}
	if receipt.Status != 1 {
		logger.Warn().Hex("tx", tx.Hash().Bytes()).Msg("failed transaction")
		callMsg := ethereum.CallMsg{
			From:      from,
			To:        tx.To(),
			Gas:       tx.Gas(),
			GasTipCap: tx.GasTipCap(),
			GasFeeCap: tx.GasFeeCap(),
			Value:     tx.Value(),
			Data:      tx.Data(),
		}
		data, err := client.CallContract(ctx, callMsg, receipt.BlockNumber)
		if err != nil {
			return nil, errors.Wrapf(err, "transaction %v failed", methodName)
		}
		return nil, errors.Errorf("transaction %v failed with tx %v", methodName, string(data))
	}
	return receipt, nil
}

func WaitForReceiptWithResults(ctx context.Context, client ethutils.EthClient, from ethcommon.Address, tx *types.Transaction, methodName string) (*types.Receipt, error) {
	return WaitForReceiptWithResultsAndReplaceByFee(ctx, client, from, tx, methodName, nil)
}
